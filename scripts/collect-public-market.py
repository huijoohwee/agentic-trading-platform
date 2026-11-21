"""Collect one admitted public market using the optional read-only CCXT interface."""
import argparse
import json
import subprocess
from pathlib import Path
from time import time
from urllib.parse import urlsplit

PUBLISH = Path(__file__).with_name('publish-market-snapshot.mjs')
FRAMES = ['1m', '5m', '15m', '30m', '1h', '2h', '4h', '1d', '1w', '1M']


def admission(directory, venue, symbol, kind):
    args = ['node', str(PUBLISH), str(directory), '--admission', venue, symbol, kind]
    return json.loads(subprocess.check_output(args, text=True))


def collect(exchange, market, policy, clock):
    exchange.load_markets()
    instrument = exchange.market(policy['instrument'])
    base, quote = market['symbol'].split('.')
    perpetual = market['marketType'] == 'perpetual'
    if (instrument['base'] != base or instrument['quote'] != quote or instrument.get('active') is False
        or (perpetual and not (instrument.get('swap') and instrument.get('linear') and instrument['settle'] == market['settlement']))
        or (not perpetual and not instrument.get('spot'))):
        raise ValueError('COLLECTOR_MARKET_BINDING')
    symbol = instrument['symbol']
    candles = {}
    for frame in FRAMES:
        if frame not in exchange.timeframes:
            continue
        bars = exchange.fetch_ohlcv(symbol, frame, limit=130)
        if bars:
            candles[frame] = [dict(zip(('time','open','high','low','close','volume'), bar[:6])) for bar in bars]
    ticker = exchange.fetch_ticker(symbol)
    trades = exchange.fetch_trades(symbol, limit=80)
    book = exchange.fetch_order_book(symbol, limit=20)
    if any(not isinstance(x, int) for x in (ticker.get('timestamp'), book.get('timestamp'))):
        raise ValueError('COLLECTOR_SOURCE_TIME_REQUIRED')
    observed = clock()
    at = max(book['timestamp'], ticker['timestamp'], *(t['timestamp'] for t in trades))
    if not 0 <= observed-at <= 15000 or at-min(book['timestamp'],ticker['timestamp'])>15000:
        raise ValueError('COLLECTOR_STALE')
    mul = instrument['contractSize'] if perpetual and policy['amountUnit']=='contracts' else 1
    out = {k: market[k] for k in ['venue','symbol','marketType','currency']}
    out.update(schema='public-market-snapshot/v1', sequence=at, at=at, timeUnits='UTC_ms', candles=candles,
               ticker=dict(last=ticker['last'], high=ticker['high'], low=ticker['low'], volume=ticker['baseVolume'],
                           change=ticker['percentage']), bookAt=book['timestamp'], tickerAt=ticker['timestamp'])
    for side in ('bids','asks'):
        out[side] = [dict(price=r[0],amount=r[1]*mul) for r in book[side][:20]]
    out['tape'] = []
    for trade in trades:
        side = trade['side']
        if side not in ('buy','sell'):
            raise ValueError('TRADE_SIDE_UNAVAILABLE')
        buyer = (side=='buy') == (policy['tradeSide']=='taker')
        out['tape'].append(dict(time=trade['timestamp'],price=trade['price'],amount=trade['amount']*mul,
                                aggressor='buyer' if buyer else 'seller'))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('directory', type=Path)
    ap.add_argument('venue')
    ap.add_argument('symbol')
    ap.add_argument('market_type', choices=['spot','perpetual'])
    args = ap.parse_args()
    market = admission(args.directory,args.venue,args.symbol,args.market_type)
    policy = market.get('collector', {})
    if (not policy.get('hosts') or policy.get('tradeSide') not in ('maker','taker')
        or policy.get('amountUnit') not in ('contracts','base') or policy.get('candleVolumeUnit')!='base'
        or market['marketType']=='spot' and policy['amountUnit']!='base'):
        raise ValueError('REVIEWED_COLLECTOR_MAPPING_REQUIRED')
    import ccxt
    if policy.get('exchange') not in ccxt.exchanges:
        raise ValueError('REVIEWED_EXCHANGE_REQUIRED')
    exchange = getattr(ccxt,policy['exchange'])({'enableRateLimit':True,'timeout':5000})
    exchange.session.max_redirects = 0
    original = exchange.fetch
    count = 0
    def bounded(url, method='GET', headers=None, body=None):
        nonlocal count
        count += 1
        parsed=urlsplit(url)
        if (count>24 or method!='GET' or body or parsed.scheme!='https' or parsed.username or parsed.password
            or parsed.port not in (None,443) or parsed.hostname not in policy['hosts']):
            raise ValueError('COLLECTOR_CALL_BOUNDARY')
        return original(url,method,headers,body)
    exchange.fetch=bounded
    snap=collect(exchange,market,policy,lambda:int(time()*1000))
    receipt = subprocess.check_output(['node',str(PUBLISH),str(args.directory),'-'],
                                      input=json.dumps(snap, allow_nan=False),text=True)
    print(json.dumps({'calls':count,'hardCapUsd':0,'at':snap['at'],'receipt':json.loads(receipt)}))


if __name__=='__main__':
    main()
