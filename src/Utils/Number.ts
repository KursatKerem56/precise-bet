// toFixed but it's returning a number instead of a string
const toFixed = (num: string | number, precision = 2) => {
  if (typeof num === "string") {
    num = parseFloat(num);
  }

  return parseFloat(num.toFixed(precision));
};

export { toFixed };
