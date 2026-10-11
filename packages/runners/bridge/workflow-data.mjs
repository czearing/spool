const forbidden = new Set(["__proto__", "prototype", "constructor"]);
export function readField(value, key) {
  if (!/^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/.test(key)) throw new Error(`Invalid data path: ${key}`);
  for (const part of key.split(".")) {
    if (forbidden.has(part) || value === null || typeof value !== "object" || !Object.hasOwn(value, part))
      throw new Error(`Input field is missing: ${key}`);
    value = value[part];
  }
  return value;
}
export function mapValue(value, context) {
  if (Array.isArray(value)) return value.map(item => mapValue(item, context));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapValue(item, context)]));
  if (typeof value !== "string") return value;
  const whole = value.match(/^\s*\{\{([\w.-]+)\}\}\s*$/);
  if (whole) return readField(context, whole[1]);
  return value.replace(/\{\{([\w.-]+)\}\}/g, (_match, key) => {
    const result = readField(context, key);
    if (result !== null && typeof result === "object") throw new Error(`Use a whole-value mapping for ${key}.`);
    return String(result);
  });
}
export function mapJson(value, context) {
  return mapValue(/^\s*\{\{[\w.-]+\}\}\s*$/.test(value) ? value : JSON.parse(value), context);
}
export function filterInput(step, input) {
  let actual;
  try { actual = readField(input, step.field); }
  catch (error) { if (step.operator === "exists" && error.message.startsWith("Input field is missing:")) return false; throw error; }
  if (step.operator === "exists") return actual !== null;
  let expected = step.compare || "";
  try { expected = JSON.parse(expected); } catch (error) { if (!(error instanceof SyntaxError)) throw error; }
  if (step.operator === "contains") {
    if (typeof actual !== "string" && !Array.isArray(actual)) throw new Error("Contains requires text or an array.");
    return actual.includes(expected);
  }
  const equal = JSON.stringify(actual) === JSON.stringify(expected);
  return step.operator === "equals" ? equal : !equal;
}
export function boundedJson(value, max = 65536) {
  const text = JSON.stringify(value);
  if (text === undefined || Buffer.byteLength(text) > max) throw new Error(`Block data must be JSON and at most ${max} bytes.`);
  return JSON.parse(text);
}
