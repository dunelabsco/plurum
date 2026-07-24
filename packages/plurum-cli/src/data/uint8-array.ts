const BASE_UINT8_ARRAY = Uint8Array;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype);
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "byteLength",
)?.get;
const TYPED_ARRAY_BUFFER_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "buffer",
)?.get;
const SET_BYTES = Uint8Array.prototype.set;
const FILL_BYTES = Uint8Array.prototype.fill;

export function intrinsicUint8ArrayByteLength(
  input: unknown,
): number | undefined {
  if (TYPED_ARRAY_BYTE_LENGTH_GETTER === undefined) {
    return undefined;
  }
  try {
    if (!(input instanceof BASE_UINT8_ARRAY)) {
      return undefined;
    }
    const length = Reflect.apply(
      TYPED_ARRAY_BYTE_LENGTH_GETTER,
      input,
      [],
    ) as unknown;
    return Number.isSafeInteger(length) && (length as number) >= 0
      ? (length as number)
      : undefined;
  } catch {
    return undefined;
  }
}

export function copyUint8Array(
  input: unknown,
  expectedLength: number,
): Uint8Array | undefined {
  let copied: Uint8Array | undefined;
  let succeeded = false;
  try {
    if (
      !Number.isSafeInteger(expectedLength) ||
      expectedLength < 0 ||
      intrinsicUint8ArrayByteLength(input) !== expectedLength
    ) {
      return undefined;
    }
    copied = new BASE_UINT8_ARRAY(expectedLength);
    SET_BYTES.call(copied, input as Uint8Array);
    if (intrinsicUint8ArrayByteLength(copied) !== expectedLength) {
      return undefined;
    }
    succeeded = true;
    return copied;
  } catch {
    return undefined;
  } finally {
    if (copied !== undefined && !succeeded) {
      try {
        FILL_BYTES.call(copied, 0);
      } catch {
        // A detached owned buffer no longer contains accessible data.
      }
    }
  }
}

function hasExclusiveArrayBuffer(input: Uint8Array): boolean {
  if (TYPED_ARRAY_BUFFER_GETTER === undefined) {
    return false;
  }
  try {
    const buffer = Reflect.apply(
      TYPED_ARRAY_BUFFER_GETTER,
      input,
      [],
    ) as unknown;
    return buffer instanceof ArrayBuffer;
  } catch {
    return false;
  }
}

export function copyUint8ArrayInto(
  target: unknown,
  offset: number,
  input: unknown,
): boolean {
  const targetLength = intrinsicUint8ArrayByteLength(target);
  const inputLength = intrinsicUint8ArrayByteLength(input);
  if (
    targetLength === undefined ||
    inputLength === undefined ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    inputLength > targetLength - offset
  ) {
    return false;
  }
  try {
    if (
      !hasExclusiveArrayBuffer(target as Uint8Array) ||
      !hasExclusiveArrayBuffer(input as Uint8Array)
    ) {
      return false;
    }
    SET_BYTES.call(
      target as Uint8Array,
      input as Uint8Array,
      offset,
    );
    return true;
  } catch {
    return false;
  }
}

export function copyUint8ArrayPrefix(
  input: unknown,
  prefixLength: number,
): Uint8Array | undefined {
  const inputLength = intrinsicUint8ArrayByteLength(input);
  let copied: Uint8Array | undefined;
  let succeeded = false;
  try {
    if (
      inputLength === undefined ||
      !Number.isSafeInteger(prefixLength) ||
      prefixLength < 0 ||
      prefixLength > inputLength ||
      !hasExclusiveArrayBuffer(input as Uint8Array)
    ) {
      return undefined;
    }
    copied = new BASE_UINT8_ARRAY(prefixLength);
    for (let index = 0; index < prefixLength; index += 1) {
      copied[index] = (input as Uint8Array)[index] ?? 0;
    }
    succeeded =
      intrinsicUint8ArrayByteLength(copied) === prefixLength;
    return succeeded ? copied : undefined;
  } catch {
    return undefined;
  } finally {
    if (copied !== undefined && !succeeded) {
      try {
        FILL_BYTES.call(copied, 0);
      } catch {
        // A detached owned buffer no longer contains accessible data.
      }
    }
  }
}

export function wipeUint8Array(input: unknown): boolean {
  const length = intrinsicUint8ArrayByteLength(input);
  if (length === undefined) {
    return false;
  }
  try {
    FILL_BYTES.call(input as Uint8Array, 0);
    return intrinsicUint8ArrayByteLength(input) === length;
  } catch {
    // A detached buffer no longer contains accessible data.
    return intrinsicUint8ArrayByteLength(input) === 0;
  }
}
