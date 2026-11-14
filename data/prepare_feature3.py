"""Usage: python prepare_feature3.py SOURCE_DIRECTORY OUTPUT_DIRECTORY
Requires pandas and numpy. Reads the four uploaded source files, not live services.
"""
import io,json,re,sys,hashlib
from pathlib import Path
import numpy as np
import pandas as pd
src=Path(sys.argv[1]);out=Path(sys.argv[2]);out.mkdir(parents=True,exist_ok=True)
def save(d,name):d.to_csv(out/name,index=False)
docs={}
for f in ['radlab_donki_2024-05.txt','radlab_2024-05_extra.txt','donki_2024-05_full.txt']:
 parts=re.split(r'(?m)^# .*\nURL: (\S+)\n\n',(src/f).read_text())
 for i in range(1,len(parts)-1,2):docs[parts[i]]=parts[i+1]
frames=[]
for u,s in docs.items():
 if 'radlab' not in u or 'DosTel1' not in u:continue
 s=s.split('\n\nError fetching')[0]
 d=pd.read_csv(io.StringIO(s),skipinitialspace=True);d.columns=d.columns.str.strip();frames.append(d)
d=pd.concat(frames,ignore_index=True);raw_count=len(d)
d.timestamp=pd.to_datetime(d.timestamp.astype(str).str.strip(),utc=True,errors='coerce')
for c in ['absorbed_dose_rate','latitude','longitude','altitude']:d[c]=pd.to_numeric(d[c],errors='coerce')
invalid=d.timestamp.isna()|~d.absorbed_dose_rate.between(0,5000,inclusive='left')|~d.latitude.between(-52,52)|~d.longitude.between(-180,180)|~d.altitude.between(350,480)
save(d.loc[invalid],'radiation_rejected_rows.csv')
d=d[~invalid].drop_duplicates('timestamp').sort_values('timestamp')
r=d.set_index('timestamp').resample('5min').agg(dose_rate_ugy_h=('absorbed_dose_rate','mean'),dose_rate_max_ugy_h=('absorbed_dose_rate','max'),latitude=('latitude','mean'),longitude=('longitude','last'),altitude_km=('altitude','mean'),n_samples=('absorbed_dose_rate','size')).reset_index()
save(r[r.n_samples.eq(0)][['timestamp','n_samples']],'radiation_missing_bins.csv')
r=r[r.n_samples.gt(0)].reset_index(drop=True);r.insert(0,'row_id',np.arange(1,len(r)+1))
r['minutes_since_prev']=r.timestamp.diff().dt.total_seconds()/60
r['segment_id']=r.minutes_since_prev.ne(5).cumsum()
r['abs_latitude']=r.latitude.abs();r['in_saa_box']=r.latitude.between(-50,0)&r.longitude.between(-90,40)
r['region']=np.where(r.in_saa_box,'saa_box',np.where(r.abs_latitude.ge(45),'high_latitude','low_mid_latitude'))
r['lon_sin']=np.sin(np.radians(r.longitude));r['lon_cos']=np.cos(np.radians(r.longitude));r['hour_utc']=r.timestamp.dt.hour;r['date']=r.timestamp.dt.strftime('%Y-%m-%d')
r['split']=np.where(r.date.lt('2024-05-25'),'train','test')
threshold=3*r.loc[r.split.eq('train'),'dose_rate_ugy_h'].median();r['peak_threshold_ugy_h']=threshold;r['is_peak']=r.dose_rate_ugy_h.gt(threshold)
g=r.groupby('segment_id');r['lat_moving_north']=g.latitude.diff().gt(0).astype('boolean');r.loc[g.cumcount().eq(0),'lat_moving_north']=pd.NA
for n in [1,2,3,6]:r[f'dose_rate_lag_{5*n}min']=g.dose_rate_ugy_h.shift(n)
r['dose_rate_roll_median_1h']=g.dose_rate_ugy_h.transform(lambda s:s.rolling(12,min_periods=12).median())
r['dose_rate_roll_max_1h']=g.dose_rate_ugy_h.transform(lambda s:s.rolling(12,min_periods=12).max())
for n in [1,3,6]:r[f'target_dose_rate_plus_{5*n}min']=g.dose_rate_ugy_h.shift(-n).where(g['split'].shift(-n).eq(r.split))
future=pd.concat([g.is_peak.shift(-n).astype('boolean') for n in range(1,7)],axis=1)
complete=future.notna().all(axis=1)&g['split'].shift(-6).eq(r.split)
r['target_peak_within_30min']=future.fillna(False).any(axis=1).astype('boolean').where(complete,pd.NA)
r['target_window_complete']=complete
r['dose_in_observed_bin_ugy']=r.dose_rate_ugy_h/12;r['observed_dose_accumulated_day_ugy']=r.groupby('date').dose_in_observed_bin_ugy.cumsum()
r['daily_coverage_fraction']=r.groupby('date').row_id.transform('size')/288
r['source']='NASA_RadLab_DosTel1_ISS_Columbus';r['data_context']='historical_space_environment';save(r,'radiation_5min.csv')
features=['dose_rate_ugy_h','dose_rate_max_ugy_h','latitude','longitude','altitude_km','n_samples','abs_latitude','lat_moving_north','in_saa_box','lon_sin','lon_cos','hour_utc']+[f'dose_rate_lag_{n}min' for n in [5,10,15,30]]+['dose_rate_roll_median_1h','dose_rate_roll_max_1h']
ready=complete&r[features].notna().all(axis=1)
for s in ['train','test']:save(r.loc[ready&r.split.eq(s),['row_id','timestamp']+features+['target_peak_within_30min']],f'radiation_model_{s}.csv')
# Weather timeline keeps observation time distinct from returned version submission time.
def events(kind):
 u=[u for u in docs if f'/DONKI/{kind}?' in u][-1]
 return json.JSONDecoder().raw_decode(docs[u].lstrip())[0],u
rows=[];event_counts={}
for kind in ['GST','SEP']:
 es,u=events(kind);event_counts[kind]=len(es)
 for e in es:
  base={'source':'NASA_DONKI','source_query_url':u,'event_id':e.get('gstID',e.get('sepID')),'event_url':e.get('link'),'record_submission_time_utc':e.get('submissionTime'),'version_id':e.get('versionId'),'data_context':'historical_space_weather','availability_caveat':'Returned version timestamp; original publication history not established'}
  if kind=='GST':
   for x in e['allKpIndex']:rows.append(base|{'timestamp':x['observedTime'],'event_type':'geomagnetic_storm_kp_observation','value':x['kpIndex'],'unit':'Kp_index','detail':x.get('source'),'parent_event_start_utc':e.get('startTime')})
  else:rows.append(base|{'timestamp':e['eventTime'],'event_type':'solar_particle_event_report','value':1,'unit':'event_indicator','detail':'; '.join(i['displayName'] for i in (e.get('instruments') or [])),'parent_event_start_utc':e['eventTime']})
w=pd.DataFrame(rows);w.timestamp=pd.to_datetime(w.timestamp,utc=True);w=w[w.timestamp.ge('2024-05-01')&w.timestamp.lt('2024-06-01')].drop_duplicates(['event_id','timestamp','event_type']).sort_values('timestamp')
save(w,'space_weather_events.csv')
# Rules use source blood panels only. No laboratory ML training set is created.
l=pd.read_csv(src/'inspiration4_labs_long_precorrection.csv')
pan={'complete_blood_count':'blood_count','comprehensive_metabolic_panel':'blood_chemistry','serum_cardiovascular_panel':'heart_vessel_markers','serum_immune_cytokine_panel':'immune_markers'}
l=l[l.panel.isin(pan)].copy();l['panel']=l.panel.map(pan);l['astronaut_id']='I4_'+l.crew_id;l['value_as_published']=l.value
l['value_quality']='as_supplied';l['proposed_corrected_value']=np.nan
fix={'mch':29.6,'mchc':32.4,'rdw':12.9,'platelet_count':330.,'mpv':10.1,'absolute_neutrophils':6826.,'absolute_lymphocytes':1997.,'absolute_monocytes':614.,'absolute_eosinophils':125.}
m=l.crew_id.eq('C003')&l.timepoint.eq('L-92')&l.panel.eq('blood_count')
# Preserve every source record; do not silently shift or invent a missing MCH row.
susp=m&l.analyte.isin(list(fix)+['absolute_basophils'])
l.loc[susp,'value_quality']='suspected_row_shift_excluded_pending_review'
l.loc[susp,'proposed_corrected_value']=l.loc[susp,'analyte'].map(fix)
l.loc[susp,'value']=np.nan
# Proposed missing MCH is audit-only, never a measured observation.
audit=l.loc[susp,['astronaut_id','timepoint','panel','analyte','unit','value_as_published','proposed_corrected_value','value_quality']].copy()
missing={'astronaut_id':'I4_C003','timepoint':'L-92','panel':'blood_count','analyte':'mch','unit':'pg','value_as_published':np.nan,'proposed_corrected_value':29.6,'value_quality':'not_present_in_source_proposed_in_prior_script'}
audit=pd.concat([audit,pd.DataFrame([missing])],ignore_index=True);save(audit,'labs_source_review.csv')
keys=['astronaut_id','panel','analyte','unit'];pre=l[l.phase.eq('pre-flight')].groupby(keys).value.agg(preflight_mean='mean',preflight_sd='std',preflight_n='count').reset_index()
l=l.drop(columns=['baseline_mean','baseline_sd','change_from_baseline','pct_change_from_baseline','z_from_baseline','ref_status']).merge(pre,on=keys,how='left');l.preflight_n=l.preflight_n.fillna(0).astype(int)
l=l.rename(columns={'ref_min':'normal_low','ref_max':'normal_high','timeline_day':'days_from_launch'})
l['change_from_preflight']=l.value-l.preflight_mean;l['pct_change_from_preflight']=100*l.change_from_preflight/l.preflight_mean.replace(0,np.nan)
l['z_from_preflight']=l.change_from_preflight/l.preflight_sd.where(l.preflight_sd.gt(0)&l.preflight_n.ge(3))
l['reference_range_coverage']=np.select([l.normal_low.notna()&l.normal_high.notna(),l.normal_low.notna(),l.normal_high.notna()],['both_bounds','lower_only','upper_only'],default='none')
l['status']=np.select([l.value.isna(),l.reference_range_coverage.eq('none'),l.value.lt(l.normal_low),l.value.gt(l.normal_high),l.reference_range_coverage.ne('both_bounds')],['not_assessed_source_review','no_reference_range','below_supplied_range','above_supplied_range','within_available_bound'],default='within_supplied_range')
l['baseline_quality']=np.select([l.preflight_n.eq(0),l.preflight_n.lt(3),l.preflight_sd.eq(0)],['missing','fewer_than_3_samples','zero_spread'],default='available_small_n')
l['data_context']='NASA_Inspiration4_reference_labs';l=l.sort_values(['astronaut_id','timepoint_order','panel','analyte']);save(l,'inspiration4_labs_long.csv')
idx=['astronaut_id','sex','timepoint','timepoint_order','phase','days_from_launch'];c=l[l.panel.isin(['blood_count','blood_chemistry'])]
wide=c.pivot(index=idx,columns='analyte',values='value').reset_index();wide.columns.name=None;save(wide,'inspiration4_labs_wide.csv')
summary=[]
for key,a in l.groupby(keys):
 post=a[a.phase.eq('post-flight')].sort_values('timepoint_order');last=post.iloc[-1] if len(post) else None
 if last is None:continue
 summary.append(dict(zip(keys,key))|{'preflight_mean':last.preflight_mean,'preflight_sd':last.preflight_sd,'preflight_n':last.preflight_n,'postflight_available_n':int(post.value.notna().sum()),'largest_absolute_postflight_pct_change':post.pct_change_from_preflight.abs().max(),'last_timepoint':last.timepoint,'last_value':last.value,'last_pct_change_from_preflight':last.pct_change_from_preflight,'postflight_out_of_supplied_range_count':int(post.status.isin(['below_supplied_range','above_supplied_range']).sum()),'data_context':'NASA_Inspiration4_reference_labs'})
save(pd.DataFrame(summary),'inspiration4_baseline_summary.csv')
contract={'features':features,'target':'target_peak_within_30min','forecast_definition':'Any observed dose-rate bin > training-only threshold in the next 6 consecutive five-minute bins','peak_threshold_ugy_h':threshold,'threshold_rule':'3 x median training dose rate','train_dates':['2024-05-01','2024-05-24'],'test_dates':['2024-05-25','2024-05-30'],'target_policy':'Exclude gaps and train/test-crossing windows','feature_timing':'Features available at end of current five-minute bin','weather_features_in_model':False,'weather_reason':'Returned event versions lack verified historical publication availability; timeline only','reported_prior_precision':0.94,'reported_prior_recall':0.92,'prior_metrics_status':'User-reported preliminary scores, not reproduced; cannot transfer to this cleaned split','lab_use':'Rules/reference only; no pooled clinical ML training','unit_caveat':'uGy absorbed dose rate; not personal effective dose or clinical exposure limit'}
(out/'model_contract.json').write_text(json.dumps(contract,indent=2))
assert len(r)==8627 and len(l)==3190 and len(w)==34
assert not l.duplicated(['astronaut_id','timepoint','panel','analyte']).any()
assert not r.timestamp.duplicated().any()
assert l.astronaut_id.nunique()==4 and l.timepoint.nunique()==7
for n in [1,2,3,6]:
 expected=r.set_index('timestamp').dose_rate_ugy_h.reindex(pd.DatetimeIndex(r.timestamp)-pd.Timedelta(minutes=5*n)).to_numpy();got=r[f'dose_rate_lag_{n*5}min'].to_numpy();ok=np.isfinite(got);assert np.allclose(got[ok],expected[ok])
assert not r.loc[ready,features].isna().any().any()
report={'radiation_source_rows':raw_count,'radiation_valid_source_rows':len(d),'radiation_5min_rows':len(r),'missing_5min_bins':8640-len(r),'contiguous_segments':int(r.segment_id.nunique()),'training_rows':int((ready&r.split.eq('train')).sum()),'test_rows':int((ready&r.split.eq('test')).sum()),'train_positive_labels':int(r.loc[ready&r.split.eq('train'),'target_peak_within_30min'].sum()),'test_positive_labels':int(r.loc[ready&r.split.eq('test'),'target_peak_within_30min'].sum()),'space_weather_records':len(w),'weather_record_types':{k:int(v) for k,v in w.event_type.value_counts().items()},'donki_parent_objects':event_counts,'labs_rows':len(l),'labs_unassessed_source_review':int(l.value.isna().sum()),'labs_no_reference_bounds':int(l.reference_range_coverage.eq('none').sum()),'source_sha256':{f:hashlib.sha256((src/f).read_bytes()).hexdigest() for f in ['radlab_donki_2024-05.txt','radlab_2024-05_extra.txt','donki_2024-05_full.txt','inspiration4_labs_long_precorrection.csv']},'checks':'Passed counts, unique keys, observed timestamp lag alignment and complete model features'}
(out/'validation_report.json').write_text(json.dumps(report,indent=2));print(json.dumps(report,indent=2))
dictionary=[]
for p in sorted(out.glob('*.csv')):
 t=pd.read_csv(p)
 for col in t:dictionary.append({'file':p.name,'field':col,'dtype':str(t[col].dtype),'missing_count':int(t[col].isna().sum()),'description':col.replace('_',' ')})
save(pd.DataFrame(dictionary),'data_dictionary.csv')
