"""Exercise the normalized public reader using independent exchange observations."""
from pathlib import Path
import runpy

collect = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'scripts/collect-public-market.py'))['collect']
now = 1740000000000


class Exchange:
    timeframes = {'5m': True}

    def load_markets(self):
        pass

    def market(self, symbol):
        return dict(base='BTC', quote='USD', active=True, swap=True, linear=True, settle='USD',
                    contractSize=.01, symbol=symbol)

    def fetch_ohlcv(self, symbol, frame, limit):
        return [[now, 10, 12, 9, 11, 5]]

    def fetch_ticker(self, symbol):
        return dict(timestamp=now-20, last=10, high=12, low=9, baseVolume=30, percentage=1)

    def fetch_trades(self, symbol, limit):
        return [dict(timestamp=now-2, side='sell', price=10, amount=3)]

    def fetch_order_book(self, symbol, limit):
        return dict(timestamp=now, bids=[[9, 5]], asks=[[11, 7]])


exchange = Exchange()
binding = dict(venue='fixture', marketType='perpetual', symbol='BTC.USD', currency='USD', settlement='USD')
policy = dict(tradeSide='maker', amountUnit='contracts', instrument='BTC/USD:USD')
result = collect(exchange, binding, policy, lambda: now)
assert result['bids'][0]['amount'] == .05 and result['tape'] == [
    dict(time=now-2, price=10, amount=.03, aggressor='buyer')]
assert result['at'] == now and result['ticker']['volume'] == 30
try:
    collect(exchange, binding, policy, lambda: now+15001)
except ValueError as err:
    assert str(err) == 'COLLECTOR_STALE'
else:
    raise AssertionError('stale clock admitted')
