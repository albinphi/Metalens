from __future__ import annotations
import io,json,math,re,uuid,os,logging
from datetime import datetime
from pathlib import Path
from typing import Literal
import numpy as np
import pandas as pd
from fastapi import FastAPI,File,HTTPException,UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel,Field
from google import genai
from google.genai import errors,types
logger=logging.getLogger('uvicorn.error')
BASE=Path(__file__).resolve().parents[1]; STORE=BASE/'data'; STORE.mkdir(exist_ok=True); DB=STORE/'observations.csv'; HIST=STORE/'imports.json'
env_file=BASE/'.env'
if env_file.exists():
 for line in env_file.read_text(encoding='utf-8').splitlines():
  line=line.strip()
  if line and not line.startswith('#') and '=' in line:
   key,value=line.split('=',1);os.environ.setdefault(key.strip(),value.strip().strip('"').strip("'"))
SPECS={'GOLDM':(10,995,100),'GOLDTEN':(10,999,10),'GOLDGUINEA':(8,999,8),'GOLDPETAL':(1,999,1)}
ALIASES={'trade_date':['date','trade date','trade_date','tradedate'],'symbol':['symbol','commodity','contract','instrument name','commodity name'],'expiry_date':['expiry','expiry date','expiry_date','expirydate'],'open':['open','open price'],'high':['high','high price'],'low':['low','low price'],'close':['close','close price','settlement price','settlement'],'volume':['volume','vol','volume lots','volume units'],'open_interest':['open interest','oi','open interest lots'],'turnover':['turnover','value']}
app=FastAPI(title='Commodity Derivatives Intelligence API',version='0.1')
app.add_middleware(CORSMiddleware,allow_origins=['http://localhost:3000','http://127.0.0.1:3000'],allow_methods=['*'],allow_headers=['*'])
def db():
 if not DB.exists(): return pd.DataFrame(columns=['trade_date','symbol','expiry_date','close','normalized_close','open','high','low','volume','open_interest','days_to_expiry','source_file','import_id','warnings'])
 d=pd.read_csv(DB)
 for c in ['trade_date','expiry_date']: d[c]=pd.to_datetime(d[c],errors='coerce')
 return d
def history(): return json.loads(HIST.read_text()) if HIST.exists() else []
def safe(x):
 if x is None or (isinstance(x,float) and (math.isnan(x) or math.isinf(x))): return None
 if isinstance(x,(pd.Timestamp,datetime)): return x.strftime('%Y-%m-%d')
 if isinstance(x,np.integer): return int(x)
 if isinstance(x,np.floating): return safe(float(x))
 return x
def records(d): return [{k:safe(v) for k,v in row.items()} for row in d.to_dict('records')]
def parse_date(v,format_hint=None):
 s=str(v).strip()
 if re.fullmatch(r'\d{1,2}[/-]\d{1,2}[/-]\d{4}',s):
  a,b,*_=re.split(r'[/-]',s)
  if int(a)<=12 and int(b)<=12 and format_hint not in ('DMY','MDY'):return pd.NaT
  order=format_hint or 'DMY'
  fmt=('%d/%m/%Y' if order=='DMY' else '%m/%d/%Y') if '/' in s else ('%d-%m-%Y' if order=='DMY' else '%m-%d-%Y')
  try:return pd.Timestamp(datetime.strptime(s,fmt))
  except ValueError:return pd.NaT
 return pd.to_datetime(s,errors='coerce',dayfirst=True)
def ambiguous_date(v):
 s=str(v).strip()
 if not re.fullmatch(r'\d{1,2}[/-]\d{1,2}[/-]\d{4}',s):return False
 dmy,mdy=parse_date(s,'DMY'),parse_date(s,'MDY')
 return not pd.isna(dmy) and not pd.isna(mdy) and dmy!=mdy
def auto(headers):
 norm={re.sub('[^a-z0-9]+',' ',h.lower()).strip():h for h in headers};out={}
 for k,alts in ALIASES.items():out[k]=next((norm[re.sub('[^a-z0-9]+',' ',a).strip()] for a in alts if re.sub('[^a-z0-9]+',' ',a).strip() in norm),None)
 return out
def read(content):
 try:return pd.read_csv(io.BytesIO(content),dtype=str,keep_default_na=False)
 except Exception as e:raise HTTPException(400,'Could not read CSV: '+str(e))
@app.get('/api/health')
def health():return {'status':'ok'}
@app.get('/api/dataset/status')
def status():
 d=db();return {'latest_date':safe(d.trade_date.max()) if len(d) else None,'rows':len(d),'symbols':sorted(d.symbol.unique().tolist()) if len(d) else [],'warnings':int(d.warnings.fillna('').ne('').sum()) if len(d) else 0,'imports':len(history())}
@app.post('/api/import/preview')
async def preview(file:UploadFile=File(...)):
 if not file.filename.lower().endswith('.csv'):raise HTTPException(415,'CSV supported. XLSX import is not enabled.')
 content=await file.read();d=read(content);token=str(uuid.uuid4());(STORE/(token+'.csv')).write_bytes(content);m=auto(list(d.columns))
 date_cols=[m.get('trade_date'),m.get('expiry_date')];ambiguous=any(col and d[col].map(ambiguous_date).any() for col in date_cols)
 return {'token':token,'filename':file.filename,'headers':list(d.columns),'mapping':m,'sample':d.head(5).to_dict('records'),'row_count':len(d),'ambiguous_dates':ambiguous}
class Confirm(BaseModel):
 token:uuid.UUID;filename:str;mapping:dict[str,str|None];date_format:Literal['DMY','MDY']|None=None
@app.post('/api/import/confirm')
def confirm(q:Confirm):
 token=str(q.token);path=STORE/(token+'.csv')
 if not path.exists():raise HTTPException(404,'Preview expired. Upload again.')
 src=read(path.read_bytes())
 missing=[k for k in ['trade_date','symbol','expiry_date','close'] if not q.mapping.get(k) or q.mapping[k] not in src.columns]
 if missing:raise HTTPException(422,'Map required columns: '+', '.join(missing))
 rows=[];errors=[]
 for i,s in src.iterrows():
  t=parse_date(s[q.mapping['trade_date']],q.date_format);e=parse_date(s[q.mapping['expiry_date']],q.date_format);sym=str(s[q.mapping['symbol']]).strip().upper();issues=[]
  def num(k):
   col=q.mapping.get(k);v=str(s[col]).strip() if col else ''
   if v.upper() in ('','-','NA','N/A','NULL'):return np.nan
   try:return float(v.replace(',',''))
   except:return np.nan
  z={k:num(k) for k in ['open','high','low','close','volume','open_interest']}
  if pd.isna(t):issues.append('Invalid or ambiguous trade date')
  if pd.isna(e):issues.append('Invalid or ambiguous expiry')
  if sym not in SPECS:issues.append('Unsupported symbol '+sym)
  if not np.isfinite(z['close']) or z['close']<=0:issues.append('Close must be positive numeric')
  if not pd.isna(t) and not pd.isna(e) and e<t:issues.append('Expiry precedes trade date')
  for k in ['volume','open_interest']:
   if np.isfinite(z[k]) and z[k]<0:issues.append(k+' cannot be negative')
  o,h,l,c=(z[k] for k in ['open','high','low','close'])
  if all(np.isfinite(x) for x in [o,h,l,c]) and not(l<=o<=h and l<=c<=h):issues.append('OHLC consistency check failed')
  if issues:errors.append({'row':i+2,'symbol':sym,'issues':'; '.join(issues),'raw':json.dumps(s.to_dict())});continue
  weight,purity,_=SPECS[sym];den=weight*purity/1000
  rows.append({'trade_date':t,'symbol':sym,'expiry_date':e,**z,'normalized_close':c/den,'normalized_open':o/den if np.isfinite(o) else np.nan,'normalized_high':h/den if np.isfinite(h) else np.nan,'normalized_low':l/den if np.isfinite(l) else np.nan,'days_to_expiry':(e-t).days,'source_file':q.filename,'import_id':token,'warnings':'Contract spec is starting value; historical validity unverified'})
  # duplicate checks reject conflicting keys and drop identical duplicates
 d=pd.DataFrame(rows);dups=0;accepted_count=0
 if len(d):
  key=['trade_date','symbol','expiry_date']
  for _,g in d[d.duplicated(key,keep=False)].groupby(key):
   if len(g.drop(columns=['source_file','import_id','warnings']).drop_duplicates())>1:
    errors.append({'row':'duplicate','symbol':g.iloc[0].symbol,'issues':'Conflicting duplicate key excluded','raw':''});d=d.drop(g.index)
   else:d=d.drop(g.index[1:]);dups+=1
  old=db();
  # Compare incoming keys with prior imports; conflicting keys are removed from analytics.
  if len(old):
   kept=[]
   value_cols=['open','high','low','close','volume','open_interest']
   old_keys={tuple(r) for r in old[key].itertuples(index=False,name=None)}
   for idx,r in d.iterrows():
    k=tuple(r[c] for c in key)
    if k not in old_keys:kept.append(idx);continue
    prior=old[[tuple(v)==k for v in old[key].itertuples(index=False,name=None)]]
    same=len(prior)==1 and all((pd.isna(r[c]) and pd.isna(prior.iloc[0][c])) or r[c]==prior.iloc[0][c] for c in value_cols)
    if same:dups+=1
    else:
     errors.append({'row':'existing duplicate','symbol':r.symbol,'issues':'Conflicting duplicate with prior import; key excluded from analytics','raw':''})
     old=old[[tuple(v)!=k for v in old[key].itertuples(index=False,name=None)]]
   d=d.loc[kept]
  accepted_count=len(d)
  d=pd.concat([old,d],ignore_index=True).drop_duplicates(key,keep='last').sort_values(key);d.to_csv(DB,index=False,date_format='%Y-%m-%d')
 raw_dir=STORE/'raw';raw_dir.mkdir(exist_ok=True);path.replace(raw_dir/(token+'-source.csv'))
 item={'id':token,'filename':q.filename,'uploaded_at':datetime.now().isoformat(timespec='seconds'),'rows':accepted_count,'rejected':len(errors),'warnings':dups,'status':'completed' if not errors else 'completed with rejected rows','date_from':safe(min([r['trade_date'] for r in rows])) if rows else None,'date_to':safe(max([r['trade_date'] for r in rows])) if rows else None,'errors':errors}
 h=history();h.insert(0,item);HIST.write_text(json.dumps(h,indent=2));return item
@app.get('/api/import/history')
def imports():return history()
@app.get('/api/contracts')
def contracts():
 d=db();return {'symbols':sorted(d.symbol.unique()) if len(d) else [],'contracts':records(d[['symbol','expiry_date']].drop_duplicates().sort_values(['symbol','expiry_date'])) if len(d) else [],'specs':{k:{'quoted_weight_grams':v[0],'purity_per_thousand':v[1],'lot_size_grams':v[2],'verified':False} for k,v in SPECS.items()}}
@app.get('/api/observations')
def observations(symbol:str|None=None,expiry:str|None=None,start:str|None=None,end:str|None=None):
 d=db()
 if symbol:d=d[d.symbol==symbol.upper()]
 if expiry:d=d[d.expiry_date==pd.Timestamp(expiry)]
 if start:d=d[d.trade_date>=pd.Timestamp(start)]
 if end:d=d[d.trade_date<=pd.Timestamp(end)]
 return records(d.sort_values('trade_date'))
class Pair(BaseModel):
 symbol_a:str;expiry_a:str;symbol_b:str;expiry_b:str
 window:int=Field(60,ge=2,le=500);minimum:int=Field(30,ge=2,le=500);entry:float=Field(2,gt=0);exit:float=Field(.5,ge=0);expiry_gap:int=Field(7,ge=0,le=365)
def pair(q):
 d=db();a=d[(d.symbol==q.symbol_a.upper())&(d.expiry_date==pd.Timestamp(q.expiry_a))].set_index('trade_date');b=d[(d.symbol==q.symbol_b.upper())&(d.expiry_date==pd.Timestamp(q.expiry_b))].set_index('trade_date');days=a.index.intersection(b.index)
 if not len(days):return pd.DataFrame()
 x=pd.DataFrame(index=days)
 for tag,leg in [('a',a),('b',b)]:
  for c in ['normalized_close','close','volume','open_interest','days_to_expiry','expiry_date']:x[tag+'_'+c]=leg.loc[days,c]
 x=x.sort_index();x['spread_pct']=100*(x.a_normalized_close/x.b_normalized_close-1);x['spread_inr_per_fine_gram']=x.a_normalized_close-x.b_normalized_close;x['expiry_gap']=(x.a_expiry_date-x.b_expiry_date).abs().dt.days
 roll=x.spread_pct.rolling(q.window,min_periods=q.minimum);x['z_score']=(x.spread_pct-roll.mean())/roll.std(ddof=1).replace(0,np.nan)
 prior=x.spread_pct.shift().rolling(q.window,min_periods=q.minimum);x['decision_z']=(x.spread_pct-prior.mean())/prior.std(ddof=1).replace(0,np.nan)
 x['eligible']=x.expiry_gap<=q.expiry_gap;x['signal']=np.where(x.eligible&(x.a_days_to_expiry>3)&(x.b_days_to_expiry>3)&(x.decision_z.abs()>=q.entry),np.where(x.decision_z>0,'Short A / Long B','Long A / Short B'),'')
 return x
class ConclusionRequest(BaseModel):
 scope:Literal['dataset','pair']='dataset'
 pair:Pair|None=None
@app.get('/api/ai/status')
def ai_status():
 return {'configured':bool(os.getenv('GEMINI_API_KEY')),'provider':'Google Gemini API'}
@app.post('/api/ai/conclusion')
def ai_conclusion(q:ConclusionRequest):
 d=db()
 if d.empty:raise HTTPException(422,'Import historical observations before requesting a data conclusion.')
 latest=d.trade_date.max(); recent=d[d.trade_date==latest]
 facts={'scope':q.scope,'data_as_of':safe(latest),'valid_rows':len(d),'symbols_present':sorted(d.symbol.unique().tolist()),'rows_on_latest_date':records(recent[['symbol','expiry_date','normalized_close','days_to_expiry','volume','open_interest']].sort_values(['symbol','expiry_date'])),'quality_warning_rows':int(d.warnings.fillna('').ne('').sum()),'specification_caveat':'Contract purity and quotation metadata are starting values and are not historically verified.'}
 if q.scope=='pair':
  if q.pair is None:raise HTTPException(422,'Provide the selected symbol and expiry pair.')
  x=pair(q.pair)
  if x.empty:raise HTTPException(422,'No overlapping observations exist for the selected pair.')
  r=x.iloc[-1]
  facts['pair']={'symbol_a':q.pair.symbol_a,'expiry_a':q.pair.expiry_a,'symbol_b':q.pair.symbol_b,'expiry_b':q.pair.expiry_b,'paired_observations':len(x),'latest_date':safe(x.index[-1]),'normalized_close_a_inr_per_fine_gram':safe(r.a_normalized_close),'normalized_close_b_inr_per_fine_gram':safe(r.b_normalized_close),'spread_pct':safe(r.spread_pct),'display_z_score':safe(r.z_score),'decision_z_score_using_prior_data':safe(r.decision_z),'expiry_gap_days':safe(r.expiry_gap),'days_to_expiry_a':safe(r.a_days_to_expiry),'days_to_expiry_b':safe(r.b_days_to_expiry),'eligible_under_configured_expiry_gap':bool(r.expiry_gap<=q.pair.expiry_gap),'candidate_signal':str(r.signal) if r.signal else None,'window':q.pair.window,'minimum_observations':q.pair.minimum,'entry_threshold':q.pair.entry,'configured_expiry_gap_days':q.pair.expiry_gap}
  spread_read=(f"{q.pair.symbol_a} is about {abs(r.spread_pct):.2f}% more expensive than {q.pair.symbol_b} on the latest matched date, after normalization." if r.spread_pct>0 else f"{q.pair.symbol_a} is about {abs(r.spread_pct):.2f}% cheaper than {q.pair.symbol_b} on the latest matched date, after normalization." if pd.notna(r.spread_pct) else 'The latest relative price difference is unavailable.')
  eligible=bool(r.expiry_gap<=q.pair.expiry_gap and r.a_days_to_expiry>3 and r.b_days_to_expiry>3)
  if len(x)<q.pair.minimum or pd.isna(r.decision_z):
   opportunity={'status':'INSUFFICIENT_HISTORY','label':'Too little history to judge an opportunity','reason':f"{spread_read} This is a price gap, not evidence that it will close. Only {len(x)} matched date(s) are available; the rule needs {q.pair.minimum} prior matched observations to calculate an entry score.",'next_step':'Import more historical data for both exact contracts, then run this pair again. Until then, treat it as a watch item, not a trading setup.'}
  elif not eligible:
   opportunity={'status':'NOT_ELIGIBLE','label':'This pair does not pass the current eligibility rules','reason':f"The pair fails the configured expiry-gap or days-to-expiry filter (expiry gap limit: {q.pair.expiry_gap} days; each leg must have more than 3 days remaining).",'next_step':'Choose a pair that meets the expiry rules or review the rules before interpreting a signal.'}
  elif r.signal:
   direction=str(r.signal)
   opportunity={'status':'CANDIDATE_SIGNAL','label':'Candidate relative-value signal — review before acting','reason':f"The prior-data Z-score crossed the configured entry threshold of {q.pair.entry:g}. The rule-based direction is {direction}; this is a historical research flag, not a forecast.",'next_step':'Check current bid/ask prices, liquidity, contract specifications, fees and slippage. Review the held-out backtest before deciding whether the setup is worth further study.'}
  else:
   opportunity={'status':'NO_ENTRY_SIGNAL','label':'No entry signal under the current rules','reason':f"The latest prior-data Z-score has not crossed the entry threshold of {q.pair.entry:g}, or the score is otherwise unavailable.",'next_step':'Keep the pair on watch and import more observations if needed. Do not force a trade by lowering the threshold just to create a signal.'}
  facts['opportunity_read']=opportunity
 else:
  all_candidates=signals(min_z=2,eligible_only=True)
  facts['latest_candidate_signals']=all_candidates[:5]
  facts['latest_normalized_prices_are_observations_not_live_quotes']=True
  facts['opportunity_read']=({'status':'CANDIDATES_TO_REVIEW','label':f"{len(all_candidates)} candidate signal(s) to review",'reason':'These are historical rule-based flags from the imported data, not live quotes or predictions.','next_step':'Open Signal Monitor, verify each pair’s current prices and liquidity, and review its held-out backtest before considering any live position.'} if all_candidates else {'status':'NO_CURRENT_CANDIDATE','label':'No candidate opportunity flagged in the latest imported data','reason':'The current dataset contains no eligible signal that meets the selected screening threshold.','next_step':'Import more matched history and review the Signal Monitor later; do not lower thresholds solely to force a candidate.'})
 api_key=os.getenv('GEMINI_API_KEY')
 if not api_key:raise HTTPException(503,'Gemini is not configured. Set GEMINI_API_KEY in backend/.env and restart the backend.')
 system=('You explain commodity relative-value metrics to a non-specialist trader. Use plain, concise language and only the supplied facts. Never invent or recalculate metrics, market context, or forecasts. Explain whether the current figures show a meaningful opportunity under the app rules, or why they do not. Treat opportunity_read as the authoritative rule-based assessment; do not upgrade it into a stronger signal. Explain any candidate direction only if candidate_signal is present. Give the next step from opportunity_read. Do not tell the user to place a live trade or present this as personalized investment advice. Mention data limitations and that normalized settlement prices are not executable quotes. Output plain text only: no Markdown, no # headings, no asterisks, no backticks, and no Markdown bullets. Use these section labels on separate lines: Plain-language reading; Opportunity read; What to do next; Important limits.')
 user='Explain the metrics and opportunity_read below for a simple trader. Keep it short, translate percentages and scores into ordinary language, and clearly distinguish a research flag from a live trading opportunity. If a metric is null or unavailable, say so. Supplied facts: '+json.dumps(facts,allow_nan=False)
 primary=os.getenv('GEMINI_MODEL','gemini-3.1-flash-lite')
 secondary=os.getenv('GEMINI_FALLBACK_MODEL','gemini-3.8-flash')
 client=genai.Client(api_key=api_key,http_options=types.HttpOptions(timeout=20000,retry_options=types.HttpRetryOptions(attempts=3,initial_delay=1,max_delay=3,exp_base=2,jitter=0.5,http_status_codes=[408,500,502,503,504])))
 config=types.GenerateContentConfig(system_instruction=system,temperature=0.2,max_output_tokens=350)
 last_error=None
 for index,model_name in enumerate(dict.fromkeys([primary,secondary])):
  try:
   response=client.models.generate_content(model=model_name,contents=user,config=config)
   text=(response.text or '').strip()
   if not text:raise HTTPException(502,'Gemini returned an empty response. Please retry.')
   text=re.sub(r'(?m)^\s*[*+-]\s+','• ',text)
   text=text.replace('#','').replace('*','').replace('`','').replace('__',' ').replace('_',' ')
   return {'analysis':text,'opportunity':facts.get('opportunity_read'),'source':'gemini','data_as_of':facts['data_as_of'],'scope':q.scope,'facts':facts,'notice':'Historical research interpretation only. Settlement prices are not executable quotes; verify live prices, liquidity, contract terms and costs before making any decision.'}
  except errors.APIError as e:
   last_error=e;code=getattr(e,'code',None);detail=str(getattr(e,'message','') or '')
   if code==429:raise HTTPException(429,'Gemini rate limit or quota reached. Check the Google AI Studio quota for this API key and try again later.')
   if code in (400,401,403):raise HTTPException(502,'Gemini rejected the request or API key. Check that the backend API key is valid and enabled for the Gemini API.'+((' '+detail[:180]) if detail else ''))
   if code==404:raise HTTPException(502,'Gemini could not find a configured model. Check GEMINI_MODEL and GEMINI_FALLBACK_MODEL in backend/.env.'+((' '+detail[:150]) if detail else ''))
   if code not in (408,500,502,503,504):raise HTTPException(502,'Gemini API returned an unexpected error ('+str(code)+').' + ((' '+detail[:180]) if detail else ''))
   logger.warning('Gemini model attempt %s returned upstream HTTP %s.',index+1,code)
   if index==0 and primary!=secondary:continue
   raise HTTPException(503,'Gemini is temporarily unavailable after retrying both configured Gemini models. Please try again shortly.'+((' Provider status: '+str(code)+'.') if code else ''))
  except HTTPException:raise
  except Exception as e:
   logger.error('Gemini request failed (%s).',type(e).__name__)
   raise HTTPException(503,'Could not reach Gemini. Check the backend network connection and retry.')
 if last_error:
  raise HTTPException(503,'Gemini is temporarily unavailable after retrying both configured Gemini models. Please try again shortly.')
@app.post('/api/analytics/compare')
def compare(q:Pair):
 x=pair(q);return {'data':records(x.reset_index(names='trade_date')) if len(x) else [],'eligible':bool(len(x) and x.expiry_gap.le(q.expiry_gap).any()),'observations':len(x),'warning':None if len(x) else 'No paired observations for selected contracts.'}
@app.get('/api/signals')
def signals(min_z:float=2,eligible_only:bool=True):
 d=db();cs=list(d[['symbol','expiry_date']].drop_duplicates().itertuples(index=False,name=None));out=[]
 for i,(sa,ea) in enumerate(cs):
  for sb,eb in cs[i+1:]:
   if sa==sb:continue
   q=Pair(symbol_a=sa,expiry_a=ea.strftime('%Y-%m-%d'),symbol_b=sb,expiry_b=eb.strftime('%Y-%m-%d'),entry=min_z);x=pair(q)
   if x.empty or 'decision_z' not in x.columns:continue
   for dt,r in x[x.decision_z.abs()>=min_z].iterrows():
    if eligible_only and r.expiry_gap>7:continue
    out.append({'trade_date':safe(dt),'symbol_a':sa,'expiry_a':safe(ea),'symbol_b':sb,'expiry_b':safe(eb),'spread_pct':safe(r.spread_pct),'z_score':safe(r.decision_z),'expiry_gap':safe(r.expiry_gap),'direction':'Short A / Long B' if r.decision_z>0 else 'Long A / Short B','eligible':bool(r.expiry_gap<=7),'explanation':f"Z-score {r.decision_z:.2f}; threshold ±{min_z:.2f}; expiry gap {r.expiry_gap} days. Historical candidate, not recommendation."})
 return sorted(out,key=lambda x:x['trade_date'],reverse=True)
class Backtest(Pair):
 slippage_bps:float=Field(2,ge=0);fee_bps:float=Field(2,ge=0);split:float=Field(.7,gt=.5,lt=.9)
@app.post('/api/backtests/run')
def backtest(q:Backtest):
 x=pair(q);n=len(x)
 minimum_history=5
 if n<minimum_history:return {'status':'insufficient_history','message':f'Backtesting needs at least {minimum_history} matched trading-date observations for this pair. Current history: {n}.','observations':n,'minimum_observations':minimum_history,'trades':[]}
 cut=int(n*q.split);dates=list(x.index);position=None;trades=[];skipped=[];i=0
 while i<n-1:
  r=x.iloc[i]
  if dates[i]<dates[cut]:i+=1;continue
  if position is None and r.eligible and r.a_days_to_expiry>3 and r.b_days_to_expiry>3 and pd.notna(r.decision_z) and abs(r.decision_z)>=q.entry:position={'entry':i+1,'direction':'short' if r.decision_z>0 else 'long'};i+=1;continue
  if position and ((pd.notna(r.z_score) and abs(r.z_score)<=q.exit) or r.a_days_to_expiry<=3 or r.b_days_to_expiry<=3):
   j=min(i+1,n-1);en=x.iloc[position['entry']];ex=x.iloc[j];es=100*(en.a_normalized_close/en.b_normalized_close-1);xs=100*(ex.a_normalized_close/ex.b_normalized_close-1);gross=es-xs if position['direction']=='short' else xs-es;cost=4*(q.slippage_bps+q.fee_bps)/100
   trades.append({'number':len(trades)+1,'entry_date':safe(dates[position['entry']]),'exit_date':safe(dates[j]),'direction':'Short A / Long B' if position['direction']=='short' else 'Long A / Short B','gross_pp':gross,'estimated_cost_pp':cost,'net_pp':gross-cost,'holding_sessions':j-position['entry']});position=None;i=j+1;continue
  i+=1
 if position:skipped.append({'reason':'Position open at end of available history'})
 cumul=0;peak=0;dd=0
 for t in trades:cumul+=t['net_pp'];peak=max(peak,cumul);dd=min(dd,cumul-peak);t['cumulative_net_pp']=cumul
 vals=[t['net_pp'] for t in trades]
 return {'status':'complete','mode':'normalized spread-return proxy','units':'percentage points','config':q.model_dump(),'development':{'start':safe(dates[0]),'end':safe(dates[cut-1]),'observations':cut},'test':{'start':safe(dates[cut]),'end':safe(dates[-1]),'observations':n-cut},'trades':trades,'skipped':skipped,'metrics':{'completed_trades':len(vals),'win_rate_pct':100*sum(v>0 for v in vals)/len(vals) if vals else None,'gross_pp':sum(t['gross_pp'] for t in trades),'estimated_costs_pp':sum(t['estimated_cost_pp'] for t in trades),'net_pp':sum(vals),'average_net_pp':float(np.mean(vals)) if vals else None,'max_drawdown_pp':dd,'average_holding_sessions':float(np.mean([t['holding_sessions'] for t in trades])) if trades else None},'warning':'Small sample: fewer than 10 test trades.' if len(vals)<10 else None}
@app.get('/api/export/observations')
def export(symbol:str|None=None):
 d=db()
 if symbol:d=d[d.symbol==symbol.upper()]
 return StreamingResponse(iter([d.to_csv(index=False)]),media_type='text/csv',headers={'Content-Disposition':'attachment; filename=observations.csv'})
@app.get('/api/export/signals')
def export_signals(min_z:float=2,eligible_only:bool=True):
 rows=signals(min_z,eligible_only)
 return StreamingResponse(iter([pd.DataFrame(rows).to_csv(index=False)]),media_type='text/csv',headers={'Content-Disposition':'attachment; filename=candidate-signals.csv'})
@app.get('/api/export/errors/{import_id}')
def error_export(import_id:str):
 x=next((x for x in history() if x['id']==import_id),None)
 if not x:raise HTTPException(404,'Import not found')
 return StreamingResponse(iter([pd.DataFrame(x.get('errors',[])).to_csv(index=False)]),media_type='text/csv',headers={'Content-Disposition':'attachment; filename=import-errors.csv'})
@app.delete('/api/dataset')
def clear(confirm:bool=False):
 if not confirm:raise HTTPException(400,'Set confirm=true to clear data')
 DB.unlink(missing_ok=True);HIST.unlink(missing_ok=True);return {'status':'cleared'}

