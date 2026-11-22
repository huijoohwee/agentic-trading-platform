"""Independent decimal reference for the single-account synthetic cash-policy test cases."""
import datetime as dt
import json
import sys
from decimal import Decimal

def instant(value):
    return dt.datetime.strptime(value, '%Y-%m-%dT%H:%M:%SZ')

def case(data):
    t = data['tickets'][0]
    q = next((q for q in data['IN_Quotes'] if q['symbol_key'] == t['symbol_key'] and q['ccy'] == t['ccy']), {})
    p = data['policy']
    rates = data['fx']
    rows = [r for r in data['IN_Positions'] if r['qty'] > 0]
    prices = {r['symbol_key']: r for r in data['IN_Quotes']}
    def rule(probe):
        try:
            return 'PASS' if probe() else 'FAIL'
        except (TypeError, KeyError, ArithmeticError):
            return 'UNKNOWN'
    try:
        cash = sum(r['cash'] * rates[r['ccy']] for r in data['IN_Balance'])
        equity = cash + sum(r['qty'] * prices[r['symbol_key']]['last'] * rates[r['ccy']] for r in rows)
    except KeyError:
        cash, equity = None, None
    held = sum(r['qty'] for r in rows if r['symbol_key'] == t['symbol_key'])
    buy = t['side'] == 'BUY'
    qty, limit, stop = (t[k] for k in ['qty', 'limit_price', 'stop_price'])
    rate = rates.get(t['ccy'])
    age = (instant(data['evaluated_utc']) - instant(q['quote_ts_utc'])).total_seconds()
    fresh = 'UNKNOWN' if age < 0 or q['delay_class'] == 'unknown' else rule(
        lambda: q['delay_class'] == 'realtime' and age <= p['maxAgeMinutes'] * 60)
    valid = bool(t['rationale'] and rate and qty > 0 and limit > 0 and t['side'] in ['BUY','SELL'] and
                 t['order_type'] == 'LIMIT' and t['created_utc'] <= data['evaluated_utc'] < t['expiry_utc'] and
                 all(p.get(k) is not None for k in ['maxAgeMinutes', 'maxPositionPct','maxRiskPct',
                     'minCashPct','maxPositions','maxDailyLoss','priceBandPct','feePerOrder']))
    working = {o['broker_order_id'] for o in data['IN_Orders'] if o['status_src'] in ['WORKING','PARTIAL']}
    identity = lambda ticket: tuple(ticket[k] for k in ['symbol_key','side','qty','limit_price'])
    duplicate = any(other['ticket_id'] != t['ticket_id'] and identity(other) == identity(t)
                    and (not other.get('broker_order_id') or other['broker_order_id'] in working) for other in data['tickets'])
    checks = [fresh, rule(lambda:valid),
              rule(lambda: (held*q['last'] + qty*limit)*rate*100 <= equity*p['maxPositionPct'] if buy else qty <= held),
              rule(lambda: not buy or 0 < stop < limit and (limit-stop)*qty*rate*100 <= equity*p['maxRiskPct']),
              rule(lambda: not buy or (cash - qty*limit*rate - p['feePerOrder'])*100 >= equity*p['minCashPct']),
              rule(lambda: not buy or held > 0 or len(rows)+1 <= p['maxPositions']),
              rule(lambda: not buy or sum(r['qty']*(prices[r['symbol_key']]['last'] - prices[r['symbol_key']]['prev_close'])*
                   rates[r['ccy']] for r in rows) > -p['maxDailyLoss']),
              rule(lambda:not duplicate), rule(lambda:abs(limit-q['last'])*100 <= q['last']*p['priceBandPct'])]
    outcome = 'HALT' if data['halt'] == 'HALT' else 'FAIL' if 'FAIL' in checks else 'REVIEW' if 'UNKNOWN' in checks else 'PASS'
    return dict(checks=checks,outcome=outcome)

print(json.dumps([case(data) for data in json.load(sys.stdin, parse_float=Decimal, parse_int=Decimal)]))
