import pandas as pd, numpy as np, json, sys
D=sys.argv[1]+"/"; R=sys.argv[2]+"/"
c=json.load(open(D+"model_contract.json")); F=c["features"]; T=c["target"]
r=pd.read_csv(D+"radiation_5min.csv",parse_dates=["timestamp"]); tr=pd.read_csv(D+"radiation_model_train.csv",parse_dates=["timestamp"]); te=pd.read_csv(D+"radiation_model_test.csv",parse_dates=["timestamp"])
ok=lambda n,v:print(("PASS " if v else "FAIL ")+n)
ok("5-min rows 8627, unique timestamps, sorted", len(r)==8627 and r.timestamp.is_unique and r.timestamp.is_monotonic_increasing)
ok("all timestamps on 5-min grid, 1-30 May 2024", (r.timestamp.dt.minute%5==0).all() and str(r.timestamp.min())[:10]=="2024-05-01" and str(r.timestamp.max())[:10]=="2024-05-30")
full=pd.date_range(r.timestamp.min(),r.timestamp.max(),freq="5min"); ok("missing bins = 13 and match file", len(full)-len(r)==13 and len(pd.read_csv(D+"radiation_missing_bins.csv"))==13)
ok("train 6797 / test 1722 rows", len(tr)==6797 and len(te)==1722)
ok("train dates within 1-24 May, test within 25-30 May", tr.timestamp.max()<pd.Timestamp("2024-05-25",tz="UTC") and te.timestamp.min()>=pd.Timestamp("2024-05-25",tz="UTC"))
ok("no row in both train and test", not set(tr.row_id)&set(te.row_id))
ok("model columns = id, time, 18 contract features, target only", list(tr.columns)==["row_id","timestamp"]+F+[T] and list(te.columns)==list(tr.columns))
ok("no missing value in any feature or target", not tr[F+[T]].isna().any().any() and not te[F+[T]].isna().any().any())
thr=3*r[r.split=="train"].dose_rate_ugy_h.median(); ok(f"threshold = 3 x training median ({thr:.5f} vs {c['peak_threshold_ugy_h']})", abs(thr-c["peak_threshold_ugy_h"])<1e-4)
s=r.set_index("timestamp").dose_rate_ugy_h
def chk(m):
    bad=0
    for ts,lab,l5,l30 in zip(m.timestamp,m[T],m.dose_rate_lag_5min,m.dose_rate_lag_30min):
        fut=[ts+pd.Timedelta(minutes=5*k) for k in range(1,7)]
        if not all(f in s.index for f in fut): bad+=1; continue
        if bool(max(s[f] for f in fut)>thr)!=bool(lab): bad+=1
        if abs(s.get(ts-pd.Timedelta(minutes=5),np.nan)-l5)>1e-9 or abs(s.get(ts-pd.Timedelta(minutes=30),np.nan)-l30)>1e-9: bad+=1
    return bad
ok("train: every label recomputed from the next 6 bins, lags match", chk(tr)==0); ok("test: every label recomputed from the next 6 bins, lags match", chk(te)==0)
ok("no train label window reaches into the test period", (tr.timestamp+pd.Timedelta(minutes=30)).max()<pd.Timestamp("2024-05-25",tz="UTC"))
print(f"     positives: train {int(tr[T].sum())} ({tr[T].mean():.1%}), test {int(te[T].sum())} ({te[T].mean():.1%})")
# against our earlier pack (only if its file is present)
import os
if os.path.exists(R+"radiation_features.csv"):
    old=pd.read_csv(R+"radiation_features.csv"); tc=[x for x in old.columns if "time" in x.lower()][0]; old[tc]=pd.to_datetime(old[tc],utc=True)
    m=r.merge(old,left_on="timestamp",right_on=tc,suffixes=("","_old")); dc=[x for x in old.columns if "dose_rate" in x and "lag" not in x and "roll" not in x and "max" not in x and "target" not in x and "plus" not in x][:1]
    print("     earlier pack: rows matched",len(m),"of",len(old),"| dose column",dc, "| max abs difference", float((m.dose_rate_ugy_h-m[dc[0]+("_old" if dc[0] in r.columns else "")]).abs().max()) if dc else None)
# labs
L=pd.read_csv(D+"inspiration4_labs_long.csv"); raw=pd.read_csv(R+"raw/inspiration4_labs_long_precorrection.csv")
ok("labs 3190 rows, 4 astronauts, 7 timepoints", len(L)==3190 and L.astronaut_id.nunique()==4 and L.timepoint.nunique()==7)
ok("labs: 9 values blanked for source review, 3181 usable", L.value.isna().sum()==9 and (L.value_quality!="as_supplied").sum()==9)
ok("labs: unique key astronaut/timepoint/panel/analyte", not L.duplicated(["astronaut_id","timepoint","panel","analyte"]).any())
vc=[x for x in raw.columns if x.lower() in("value","result")]; print("     raw lab columns:",list(raw.columns)[:12])
W=pd.read_csv(D+"space_weather_events.csv"); ok("weather 34 rows: 20 Kp + 14 particle reports", len(W)==34 and (W.event_type=="geomagnetic_storm_kp_observation").sum()==20)
dd=pd.read_csv(D+"data_dictionary.csv"); import glob,os
miss=[(os.path.basename(f),col) for f in glob.glob(D+"*.csv") if "dictionary" not in f for col in pd.read_csv(f,nrows=0).columns if not ((dd.file==os.path.basename(f))&(dd.field==col)).any()]
ok("data dictionary covers every column of every CSV", not miss); print("     undocumented:",miss[:5]) if miss else None
