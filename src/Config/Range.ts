const range = (from: number, to: number) => {
  const size = to - from + 1;
  return new Array(size).fill(0).map((_, i) => i + from);
};

export { range };
