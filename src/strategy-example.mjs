export const example = `def strategy(candles):
    prices = [bar["close"] for bar in candles]
    short_mean = sma(prices, 9)
    long_mean = sma(prices, 24)
    result = []
    for step in range(1, len(prices)):
        if crossed_above(short_mean, long_mean, step):
            result.append({"side": "buy", "time": candles[step]["time"]})
            print("Rising crossover", step)
        elif crossed_below(short_mean, long_mean, step):
            result.append({"side": "sell", "time": candles[step]["time"]})
    return result`;
