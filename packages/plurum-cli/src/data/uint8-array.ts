const BASE_UINT8_ARRAY = Uint8Array;
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype);
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  "byteLength",
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
