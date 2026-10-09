const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
export const formatUsd = (value: number) => value > 0 && value < 0.01 ? "<$0.01" : usd.format(value);
