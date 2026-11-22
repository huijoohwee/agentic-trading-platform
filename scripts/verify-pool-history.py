"""Independently check a hypothesis-8 WETH/USDC run against the publisher's Parquet bytes."""
import argparse
from datetime import datetime, timezone
import gzip
import hashlib
import json
from math import isclose
from pathlib import Path
from statistics import mean
import duckdb

DAY = 86400000
def wilder(values, period):
    result = []; seed = []; last = None
    for v in values:
        if v is None:
            seed = []; last = None
        elif last is not None:
            last += (v-last)/period
        else:
            seed.append(v)
            if len(seed)==period:
                last=mean(seed)
        result.append(last)
    return result

def verify(source, artifact):
    if hashlib.sha256(source.read_bytes()).hexdigest() != 'ed88166e388b3acf000783c354ba5888434f4c22a50c8e120cd8a6bb3dbdc58f':
        raise ValueError('SOURCE_INTEGRITY')
    raw=gzip.decompress(artifact.read_bytes());stored=json.loads(raw)
    if hashlib.sha256(raw).hexdigest()!=artifact.name.split('.')[0]:
        raise ValueError('RESULT_INTEGRITY')
    item=next(r for r in stored['rows'] if r['id']==8)
    if item['market']!={'venue':'uniswap-v3-500','symbol':'WETH.USDC','marketType':'spot','frame':'1d'}:
        raise ValueError('MARKET_BINDING')
    start,end=stored['range']['start'],stored['range']['end']
    with duckdb.connect() as db:
        bars=db.execute("""with hours as (
            select *, date_trunc('day',periodStartUnix) as day from read_parquet(?)
            where pool_name='USDC_WETH_500' and missing=0 and low>0 and high>=greatest(open,close)
            and low<=least(open,close) and epoch_ms(periodStartUnix)>=? and epoch_ms(periodStartUnix)<?)
            select epoch_ms(day),arg_min(open,periodStartUnix),max(high),min(low),arg_max(close,periodStartUnix)
            from hours group by day having count(*)=24 order by day""",[str(source),start-366*DAY,end]).fetchall()
    close=[b[4] for b in bars];changes=[None]+[b-a for a,b in zip(close,close[1:])]
    up=wilder([max(d,0) if d is not None else None for d in changes],2)
    down=wilder([max(-d,0) if d is not None else None for d in changes],2)
    rsi=[100*g/(g+l) if g is not None and g+l else 50 for g,l in zip(up,down)]
    atr=wilder([max(b[2]-b[3],abs(b[2]-close[i-1]),abs(b[3]-close[i-1])) if i else b[2]-b[3] for i,b in enumerate(bars)],14)
    cash=stored['capital'];position=None;trades=[];end_equity=cash;fee=.0006
    for i,(t,o,h,l,c) in enumerate(bars):
        if t<start or i<201:continue
        j=i-1;plan=close[j]<close[j-1]<close[j-2]<close[j-3] and rsi[j]<5 and close[j]>mean(close[j-199:j+1]) and close[j]>close[j-200]
        def exit_trade(p,px):
            shares,entry,idx,stop,buy_fee=p
            pnl=shares*(px-entry)-shares*px*fee
            trades.append((bars[idx][0],t,shares,entry,px,pnl-buy_fee))
            return pnl
        if position:
            qty,entry,idx,stop,_=position
            if o<=stop or i-idx>=5 or rsi[j]>70 or close[j]>mean(close[j-4:j+1]):
                cash+=exit_trade(position,o);position=None
        stop=close[j]-2*atr[j] if atr[j] else None
        if position is None and plan and stop is not None and o>stop:
            qty=min(.005*cash/(o-stop),2*cash/(o*(1+2*fee)));buy_fee=qty*o*fee;cash-=buy_fee
            position=(qty,o,i,stop,buy_fee)
        if position and l<=position[3]:
            cash+=exit_trade(position,position[3]);position=None
        end_equity=cash+(position[0]*(c-position[1]) if position else 0)
    expected=item['trades']
    if len(trades)!=len(expected):raise AssertionError('TRADE_COUNT')
    for independent,engine in zip(trades,expected):
        for v,key in zip(independent,['entry','exit','qty','open','price','pnl']):
            if not isclose(v,engine[key],rel_tol=1e-10,abs_tol=1e-7):raise AssertionError(key)
    ret=end_equity/stored['capital']-1
    if not isclose(ret,item['return'],abs_tol=1e-10):raise AssertionError('RETURN')
    return {'independentTrades':len(trades),'return':ret,'actual':item['actual'],'scientificHash':artifact.name.split('.')[0]}
if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('parquet',type=Path);ap.add_argument('artifact',type=Path)
    args=ap.parse_args();print(json.dumps(verify(args.parquet,args.artifact)))
