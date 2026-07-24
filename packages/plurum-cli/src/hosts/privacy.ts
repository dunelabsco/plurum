const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;

const SENSITIVE_MATERIAL = Object.freeze([
  /\bplrm_(?:live|test)_/iu,
  /\bplurum_api_key\b/iu,
  /\bauthorization\s*[:=]/iu,
  /\bbearer\s+\S+/iu,
  /\b(?:api[_ -]?key|access[_ -]?token|secret|password)\s*[:=]/iu,
  /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/?#@]*@/u,
  /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/iu,
]);

export function containsHostControlCharacter(value: string): boolean {
  return CONTROL_CHARACTER.test(value);
}

export function containsHostSensitiveMaterial(value: string): boolean {
  return SENSITIVE_MATERIAL.some((pattern) => pattern.test(value));
}
