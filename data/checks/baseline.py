import pandas as pd, numpy as np, json, sys
from sklearn.ensemble import HistGradientBoostingClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import precision_score, recall_score, roc_auc_score, average_precision_score, f1_score
# usage: python baseline.py DATA_DIRECTORY RESULTS.json [weather]   (add the word weather to use the weather variant)
V="_weather" if len(sys.argv)>3 and sys.argv[3]=="weather" else ""
D=sys.argv[1]+"/"; c=json.load(open(D+f"model_contract{V}.json")); F=c["features"]; T=c["target"]
tr=pd.read_csv(D+f"radiation_model_train{V}.csv",parse_dates=["timestamp"]); te=pd.read_csv(D+f"radiation_model_test{V}.csv",parse_dates=["timestamp"])
X=lambda d:d[F].astype(float).values
# time-based validation inside training: fit on 1-19 May, validate on 20-24 May, with a 30-minute purge before the cut
cut=pd.Timestamp("2024-05-20",tz="UTC"); fit=tr[tr.timestamp<cut-pd.Timedelta(minutes=30)]; val=tr[tr.timestamp>=cut]
res={}
for name,mk in {"logistic_regression":lambda:make_pipeline(StandardScaler(),LogisticRegression(max_iter=2000,class_weight="balanced")),
                "gradient_boosting":lambda:HistGradientBoostingClassifier(max_depth=4,learning_rate=0.08,max_iter=200,random_state=0)}.items():
    m=mk().fit(X(fit),fit[T]); pv=m.predict_proba(X(val))[:,1]
    ths=np.linspace(0.05,0.95,91); th=float(ths[int(np.argmax([f1_score(val[T],pv>=t) for t in ths]))])      # threshold chosen on validation only
    m=mk().fit(X(tr),tr[T]); pt=m.predict_proba(X(te))[:,1]; yp=pt>=th
    res[name]={"threshold_from_validation":round(th,2),"validation_f1":round(float(f1_score(val[T],pv>=th)),3),"test_precision":round(float(precision_score(te[T],yp)),3),"test_recall":round(float(recall_score(te[T],yp)),3),
               "test_f1":round(float(f1_score(te[T],yp)),3),"test_roc_auc":round(float(roc_auc_score(te[T],pt)),3),"test_average_precision":round(float(average_precision_score(te[T],pt)),3)}
# naive reference: "a peak is coming if the current bin is already above the threshold"
yp=te.dose_rate_ugy_h>c["peak_threshold_ugy_h"]; res["naive_current_bin_above_threshold"]={"test_precision":round(float(precision_score(te[T],yp)),3),"test_recall":round(float(recall_score(te[T],yp)),3),"test_f1":round(float(f1_score(te[T],yp)),3)}
res["_meta"]={"train_rows":len(tr),"test_rows":len(te),"test_positive_rate":round(float(te[T].mean()),3),"fit_rows":len(fit),"validation_rows":len(val),"features":len(F)}
print(json.dumps(res,indent=1)); json.dump(res,open(sys.argv[2],"w"),indent=1)
