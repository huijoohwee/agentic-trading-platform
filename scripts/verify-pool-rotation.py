"""Independent monthly spot portfolio oracle reading only original hourly pool observations."""
import argparse
from datetime import date, timedelta
from hashlib import sha256
import gzip
import json
from math import isclose, log, sqrt
from pathlib import Path
from statistics import mean, pstdev

import duckdb

DAY = 86400000
BASKET = ['WBTC.WETH', 'USDC.WETH', 'DAI.WETH']


def verify(source, archive):
    if sha256(source.read_bytes()).hexdigest() != 'ed88166e388b3acf000783c354ba5888434f4c22a50c8e120cd8a6bb3dbdc58f':
        raise ValueError('SOURCE_INTEGRITY')
    raw = gzip.decompress(archive.read_bytes())
    if sha256(raw).hexdigest() != archive.name.split('.')[0]:
        raise ValueError('RESULT_INTEGRITY')
    artifact = json.loads(raw)
    row = next(r for r in artifact['rows'] if r['id'] == 19)
    if row['basket'] != BASKET or row['capitalUnit'] != 'WETH':
        raise ValueError('ROTATION_BINDING')
    with duckdb.connect() as con:
        data = con.execute("""select token0_symbol, epoch_ms(date_trunc('day', periodStartUnix)) dt,
            arg_min(1/open, periodStartUnix) op, arg_max(1/close,periodStartUnix) cl
            from read_parquet(?) where pool_name in ('WBTC_WETH_500','USDC_WETH_500','DAI_WETH_500')
            and missing=0 and low>0 and high>=greatest(open,close) and low<=least(open,close)
            group by 1,2 having count(*)=24 order by 2""", [str(source)]).fetchall()
    markets = {s.split('.')[0]: {} for s in BASKET}
    for name, time, opening, close in data:
        markets[name][time] = (opening, close)
    cash = artifact['capital']
    held = {n: 0 for n in markets}
    changes, curve = [], []
    first, end = (artifact['range'][k] for k in ('start', 'end'))
    for t in range(first, end, DAY):
        if any(t not in m for m in markets.values()):
            continue
        current = date(1970, 1, 1) + timedelta(days=t//DAY)
        if current.day == 1:
            choices = []
            for name, series in markets.items():
                prices = [series.get(t-j*DAY, (None, None))[1] for j in range(201, 0, -1)]
                if None in prices:
                    break
                returns = [log(b/a) for a,b in zip(prices[-91:-1], prices[-90:])]
                vol = pstdev(returns)*sqrt(365)
                if vol == 0:
                    break
                eligible = prices[-1] > mean(prices[-200:]) and prices[-1] > prices[0]
                choices.append(((prices[-1]/prices[-91]-1)/vol, name, min(1, .15/vol) if eligible else 0))
            if len(choices) == 3:
                _, winner, weight = max(choices)
                pre = cash + sum(q*markets[n][t][0] for n,q in held.items())
                target = {n: pre*weight/markets[n][t][0] if n==winner else 0 for n in held}
                turnover = sum(abs(target[n]-held[n])*markets[n][t][0] for n in held)
                cash = pre - sum(q*markets[n][t][0] for n,q in target.items()) - .0006*turnover
                held = target
                if turnover:
                    changes.append((t, turnover, pre-.0006*turnover))
        curve.append((t, cash + sum(q*markets[n][t][1] for n,q in held.items())))
    assert len(curve) == len(row['curve']) and len(changes) == len(row['rebalances'])
    for actual, stored in zip(curve, row['curve']):
        assert actual[0] == stored['time'] and isclose(actual[1], stored['equity'], rel_tol=1e-10)
    for actual, stored in zip(changes, row['rebalances']):
        assert all(isclose(x,stored[k],rel_tol=1e-10, abs_tol=1e-10) for x,k in zip(actual,['time','turnover','equity']))
    return dict(checkedMarks=len(curve), rebalances=len(changes), capitalUnit='WETH',
                totalReturn=curve[-1][1]/artifact['capital']-1, scientificHash=archive.name.split('.')[0])


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('parquet', type=Path)
    ap.add_argument('artifact', type=Path)
    args = ap.parse_args()
    print(json.dumps(verify(args.parquet, args.artifact)))
