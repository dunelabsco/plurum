use std::fmt;

use plurum_native_secret_memory::zeroize_bytes;

const MAX_PATTERN_COUNT: usize = 32;
const MIN_PATTERN_LENGTH: usize = 8;
const MAX_PATTERN_LENGTH: usize = 512;
const REDACTION_MARKER: &[u8] = b"[REDACTED]";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RedactionError {
    InvalidPatternCount,
    InvalidPatternLength,
    DuplicatePattern,
    RawBudgetExceeded,
    EmittedBudgetExceeded,
    AllocationFailed,
    AlreadyFinished,
    Failed,
}

/// One aggregate budget is owned by the process supervisor and passed to both
/// independent stream redactors. A rejected reservation never changes usage.
#[derive(Debug, Eq, PartialEq)]
pub(crate) struct AggregateByteBudget {
    raw_limit: usize,
    emitted_limit: usize,
    raw_used: usize,
    emitted_used: usize,
}

impl AggregateByteBudget {
    pub(crate) fn new(raw_limit: usize, emitted_limit: usize) -> Self {
        Self {
            raw_limit,
            emitted_limit,
            raw_used: 0,
            emitted_used: 0,
        }
    }

    pub(crate) fn raw_used(&self) -> usize {
        self.raw_used
    }

    pub(crate) fn emitted_used(&self) -> usize {
        self.emitted_used
    }

    pub(crate) fn raw_remaining(&self) -> usize {
        self.raw_limit - self.raw_used
    }

    pub(crate) fn emitted_remaining(&self) -> usize {
        self.emitted_limit - self.emitted_used
    }

    fn charge_raw(&mut self, amount: usize) -> Result<(), RedactionError> {
        let Some(next) = self.raw_used.checked_add(amount) else {
            return Err(RedactionError::RawBudgetExceeded);
        };
        if next > self.raw_limit {
            return Err(RedactionError::RawBudgetExceeded);
        }
        self.raw_used = next;
        Ok(())
    }

    fn charge_emitted(&mut self, amount: usize) -> Result<(), RedactionError> {
        let Some(next) = self.emitted_used.checked_add(amount) else {
            return Err(RedactionError::EmittedBudgetExceeded);
        };
        if next > self.emitted_limit {
            return Err(RedactionError::EmittedBudgetExceeded);
        }
        self.emitted_used = next;
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum StreamState {
    Active,
    Finished,
    Failed,
}

struct PendingBytes {
    bytes: [u8; MAX_PATTERN_LENGTH],
    start: usize,
    len: usize,
}

impl PendingBytes {
    fn new() -> Self {
        Self {
            bytes: [0; MAX_PATTERN_LENGTH],
            start: 0,
            len: 0,
        }
    }

    fn len(&self) -> usize {
        self.len
    }

    fn push(&mut self, byte: u8) {
        debug_assert!(self.len < MAX_PATTERN_LENGTH);
        let index = (self.start + self.len) % MAX_PATTERN_LENGTH;
        self.bytes[index] = byte;
        self.len += 1;
    }

    fn byte_at(&self, offset: usize) -> u8 {
        debug_assert!(offset < self.len);
        self.bytes[(self.start + offset) % MAX_PATTERN_LENGTH]
    }

    fn starts_with(&self, pattern: &[u8]) -> bool {
        pattern.len() <= self.len
            && pattern
                .iter()
                .enumerate()
                .all(|(offset, byte)| self.byte_at(offset) == *byte)
    }

    fn discard_front(&mut self, count: usize) {
        debug_assert!(count <= self.len);
        let first_count = count.min(MAX_PATTERN_LENGTH - self.start);
        zeroize_bytes(&mut self.bytes[self.start..self.start + first_count]);
        let second_count = count - first_count;
        if second_count != 0 {
            zeroize_bytes(&mut self.bytes[..second_count]);
        }
        self.start = (self.start + count) % MAX_PATTERN_LENGTH;
        self.len -= count;
        if self.len == 0 {
            self.start = 0;
        }
    }

    fn wipe(&mut self) {
        zeroize_bytes(&mut self.bytes);
        self.start = 0;
        self.len = 0;
    }
}

impl Drop for PendingBytes {
    fn drop(&mut self) {
        self.wipe();
    }
}

/// A byte-only, leftmost-longest streaming redactor.
///
/// Construct one instance for stdout and another for stderr, then pass the
/// same externally owned `AggregateByteBudget` to both instances.
pub(crate) struct StreamingRedactor {
    patterns: Vec<Vec<u8>>,
    max_pattern_len: usize,
    pending: PendingBytes,
    state: StreamState,
}

impl StreamingRedactor {
    pub(crate) fn new(mut patterns: Vec<Vec<u8>>) -> Result<Self, RedactionError> {
        if !(1..=MAX_PATTERN_COUNT).contains(&patterns.len()) {
            wipe_patterns(&mut patterns);
            return Err(RedactionError::InvalidPatternCount);
        }
        if patterns
            .iter()
            .any(|pattern| !(MIN_PATTERN_LENGTH..=MAX_PATTERN_LENGTH).contains(&pattern.len()))
        {
            wipe_patterns(&mut patterns);
            return Err(RedactionError::InvalidPatternLength);
        }

        patterns.sort_by(|left, right| {
            right
                .len()
                .cmp(&left.len())
                .then_with(|| left.as_slice().cmp(right.as_slice()))
        });
        if patterns.windows(2).any(|pair| pair[0] == pair[1]) {
            wipe_patterns(&mut patterns);
            return Err(RedactionError::DuplicatePattern);
        }

        let max_pattern_len = patterns[0].len();
        Ok(Self {
            patterns,
            max_pattern_len,
            pending: PendingBytes::new(),
            state: StreamState::Active,
        })
    }

    pub(crate) fn push(
        &mut self,
        input: &[u8],
        budget: &mut AggregateByteBudget,
    ) -> Result<Vec<u8>, RedactionError> {
        self.require_active()?;
        if let Err(error) = budget.charge_raw(input.len()) {
            self.fail();
            return Err(error);
        }

        let capacity = match output_capacity_bound(self.pending.len(), input.len()) {
            Some(bound) => bound.min(budget.emitted_remaining()),
            None => budget.emitted_remaining(),
        };
        let mut output = Vec::new();
        if output.try_reserve_exact(capacity).is_err() {
            self.fail();
            return Err(RedactionError::AllocationFailed);
        }

        for byte in input {
            self.pending.push(*byte);
            if self.pending.len() == self.max_pattern_len {
                if let Err(error) = self.emit_front(&mut output, budget.emitted_remaining()) {
                    zeroize_bytes(output.as_mut_slice());
                    self.fail();
                    return Err(error);
                }
            }
        }

        if let Err(error) = budget.charge_emitted(output.len()) {
            zeroize_bytes(output.as_mut_slice());
            self.fail();
            return Err(error);
        }
        Ok(output)
    }

    pub(crate) fn finish(
        &mut self,
        budget: &mut AggregateByteBudget,
    ) -> Result<Vec<u8>, RedactionError> {
        self.require_active()?;

        let capacity = match output_capacity_bound(0, self.pending.len()) {
            Some(bound) => bound.min(budget.emitted_remaining()),
            None => budget.emitted_remaining(),
        };
        let mut output = Vec::new();
        if output.try_reserve_exact(capacity).is_err() {
            self.fail();
            return Err(RedactionError::AllocationFailed);
        }

        while self.pending.len() != 0 {
            if let Err(error) = self.emit_front(&mut output, budget.emitted_remaining()) {
                zeroize_bytes(output.as_mut_slice());
                self.fail();
                return Err(error);
            }
        }

        if let Err(error) = budget.charge_emitted(output.len()) {
            zeroize_bytes(output.as_mut_slice());
            self.fail();
            return Err(error);
        }
        self.state = StreamState::Finished;
        self.wipe_secrets();
        Ok(output)
    }

    fn require_active(&self) -> Result<(), RedactionError> {
        match self.state {
            StreamState::Active => Ok(()),
            StreamState::Finished => Err(RedactionError::AlreadyFinished),
            StreamState::Failed => Err(RedactionError::Failed),
        }
    }

    fn emit_front(
        &mut self,
        output: &mut Vec<u8>,
        emitted_remaining: usize,
    ) -> Result<(), RedactionError> {
        let matching_length = self
            .patterns
            .iter()
            .find(|pattern| self.pending.starts_with(pattern))
            .map(Vec::len);

        if let Some(pattern_len) = matching_length {
            append_bounded(output, REDACTION_MARKER, emitted_remaining)?;
            self.pending.discard_front(pattern_len);
        } else {
            let byte = self.pending.byte_at(0);
            append_bounded(output, &[byte], emitted_remaining)?;
            self.pending.discard_front(1);
        }
        Ok(())
    }

    fn fail(&mut self) {
        self.state = StreamState::Failed;
        self.wipe_secrets();
    }

    fn wipe_secrets(&mut self) {
        wipe_patterns(&mut self.patterns);
        self.max_pattern_len = 0;
        self.pending.wipe();
    }
}

impl fmt::Debug for StreamingRedactor {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("StreamingRedactor")
            .field("pattern_count", &self.patterns.len())
            .field("max_pattern_len", &self.max_pattern_len)
            .field("pending_len", &self.pending.len())
            .field("state", &self.state)
            .finish()
    }
}

impl Drop for StreamingRedactor {
    fn drop(&mut self) {
        self.wipe_secrets();
    }
}

fn append_bounded(
    output: &mut Vec<u8>,
    bytes: &[u8],
    emitted_remaining: usize,
) -> Result<(), RedactionError> {
    let Some(next_len) = output.len().checked_add(bytes.len()) else {
        return Err(RedactionError::EmittedBudgetExceeded);
    };
    if next_len > emitted_remaining {
        return Err(RedactionError::EmittedBudgetExceeded);
    }
    output.extend_from_slice(bytes);
    Ok(())
}

fn output_capacity_bound(pending_len: usize, input_len: usize) -> Option<usize> {
    let total = pending_len.checked_add(input_len)?;
    let expansion =
        (total / MIN_PATTERN_LENGTH).checked_mul(REDACTION_MARKER.len() - MIN_PATTERN_LENGTH)?;
    total.checked_add(expansion)
}

fn wipe_patterns(patterns: &mut Vec<Vec<u8>>) {
    for pattern in patterns.iter_mut() {
        zeroize_bytes(pattern.as_mut_slice());
        pattern.clear();
    }
    patterns.clear();
}

#[cfg(test)]
mod tests {
    use super::{
        AggregateByteBudget, RedactionError, StreamState, StreamingRedactor, MAX_PATTERN_COUNT,
        MAX_PATTERN_LENGTH, REDACTION_MARKER,
    };

    const SHORT_SECRET: &[u8] = b"abcdefgh";
    const LONG_SECRET: &[u8] = b"abcdefghij";

    fn redactor(patterns: &[&[u8]]) -> StreamingRedactor {
        StreamingRedactor::new(patterns.iter().map(|pattern| pattern.to_vec()).collect())
            .expect("patterns must be valid")
    }

    fn append(result: &mut Vec<u8>, bytes: Vec<u8>) {
        result.extend_from_slice(bytes.as_slice());
    }

    #[test]
    fn validation_rejects_invalid_counts_lengths_and_duplicates() {
        assert_eq!(
            StreamingRedactor::new(Vec::new()).expect_err("zero patterns must fail"),
            RedactionError::InvalidPatternCount,
        );
        assert_eq!(
            StreamingRedactor::new(vec![vec![b'x'; 8]; MAX_PATTERN_COUNT + 1])
                .expect_err("too many patterns must fail"),
            RedactionError::InvalidPatternCount,
        );
        assert_eq!(
            StreamingRedactor::new(vec![vec![b'x'; 7]]).expect_err("short patterns must fail"),
            RedactionError::InvalidPatternLength,
        );
        assert_eq!(
            StreamingRedactor::new(vec![vec![b'x'; MAX_PATTERN_LENGTH + 1]])
                .expect_err("long patterns must fail"),
            RedactionError::InvalidPatternLength,
        );
        assert_eq!(
            StreamingRedactor::new(vec![SHORT_SECRET.to_vec(), SHORT_SECRET.to_vec()])
                .expect_err("duplicate patterns must fail"),
            RedactionError::DuplicatePattern,
        );
    }

    #[test]
    fn accepted_pattern_bounds_are_inclusive_and_carry_is_strictly_bounded() {
        let mut maximum = vec![0xa5; MAX_PATTERN_LENGTH];
        maximum[MAX_PATTERN_LENGTH - 1] = 0x5a;
        let mut redactor =
            StreamingRedactor::new(vec![maximum.clone()]).expect("maximum pattern must be valid");
        let mut budget = AggregateByteBudget::new(MAX_PATTERN_LENGTH, 1_024);

        assert!(redactor
            .push(&maximum[..MAX_PATTERN_LENGTH - 1], &mut budget)
            .expect("prefix must fit")
            .is_empty());
        assert_eq!(redactor.pending.len(), MAX_PATTERN_LENGTH - 1);
        assert_eq!(
            redactor
                .push(&maximum[MAX_PATTERN_LENGTH - 1..], &mut budget)
                .expect("last byte must complete the match"),
            REDACTION_MARKER,
        );
        assert!(redactor
            .finish(&mut budget)
            .expect("finish must be empty")
            .is_empty());

        let mut maximum_count = Vec::new();
        for discriminator in 0..MAX_PATTERN_COUNT {
            let mut pattern = vec![b'x'; 8];
            pattern[0] = discriminator as u8;
            maximum_count.push(pattern);
        }
        StreamingRedactor::new(maximum_count).expect("maximum pattern count must be valid");
    }

    #[test]
    fn patterns_are_sorted_longest_first_with_deterministic_ties() {
        let redactor = redactor(&[b"zzzzzzzz", LONG_SECRET, b"aaaaaaaa"]);
        let lengths: Vec<usize> = redactor.patterns.iter().map(Vec::len).collect();
        assert_eq!(lengths, vec![10, 8, 8]);
        assert_eq!(redactor.patterns[1], b"aaaaaaaa");
        assert_eq!(redactor.patterns[2], b"zzzzzzzz");
    }

    #[test]
    fn a_secret_is_redacted_at_every_two_chunk_boundary() {
        for split in 0..=LONG_SECRET.len() {
            let mut redactor = redactor(&[LONG_SECRET]);
            let mut budget = AggregateByteBudget::new(1_024, 1_024);
            let mut output = Vec::new();

            append(
                &mut output,
                redactor
                    .push(&LONG_SECRET[..split], &mut budget)
                    .expect("first chunk must redact"),
            );
            append(
                &mut output,
                redactor
                    .push(&LONG_SECRET[split..], &mut budget)
                    .expect("second chunk must redact"),
            );
            append(
                &mut output,
                redactor.finish(&mut budget).expect("finish must flush"),
            );

            assert_eq!(output, REDACTION_MARKER, "split at byte {split}");
            assert_eq!(budget.raw_used(), LONG_SECRET.len());
            assert_eq!(budget.emitted_used(), REDACTION_MARKER.len());
        }
    }

    #[test]
    fn a_secret_split_into_single_bytes_is_redacted() {
        let mut redactor = redactor(&[LONG_SECRET]);
        let mut budget = AggregateByteBudget::new(1_024, 1_024);
        let mut output = Vec::new();

        for byte in LONG_SECRET {
            append(
                &mut output,
                redactor
                    .push(std::slice::from_ref(byte), &mut budget)
                    .expect("single-byte chunk must redact"),
            );
        }
        append(
            &mut output,
            redactor.finish(&mut budget).expect("finish must flush"),
        );

        assert_eq!(output, REDACTION_MARKER);
    }

    #[test]
    fn every_non_overlapping_occurrence_is_replaced() {
        let mut redactor = redactor(&[SHORT_SECRET]);
        let mut budget = AggregateByteBudget::new(1_024, 1_024);
        let mut output = redactor
            .push(b"xxabcdefghyyabcdefghzz", &mut budget)
            .expect("push must redact every occurrence");
        append(
            &mut output,
            redactor.finish(&mut budget).expect("finish must flush"),
        );

        let mut expected = b"xx".to_vec();
        expected.extend_from_slice(REDACTION_MARKER);
        expected.extend_from_slice(b"yy");
        expected.extend_from_slice(REDACTION_MARKER);
        expected.extend_from_slice(b"zz");
        assert_eq!(output, expected);
    }

    #[test]
    fn matching_is_leftmost_and_longest_at_each_position() {
        let mut longest = redactor(&[SHORT_SECRET, LONG_SECRET]);
        let mut budget = AggregateByteBudget::new(1_024, 1_024);
        let mut output = longest
            .push(LONG_SECRET, &mut budget)
            .expect("push must redact the longest pattern");
        append(
            &mut output,
            longest.finish(&mut budget).expect("finish must flush"),
        );
        assert_eq!(output, REDACTION_MARKER);

        let mut leftmost = redactor(&[SHORT_SECRET, b"defghijk"]);
        let mut output = leftmost
            .push(b"abcdefghijk", &mut budget)
            .expect("push must prefer the leftmost pattern");
        append(
            &mut output,
            leftmost.finish(&mut budget).expect("finish must flush"),
        );
        let mut expected = REDACTION_MARKER.to_vec();
        expected.extend_from_slice(b"ijk");
        assert_eq!(output, expected);
    }

    #[test]
    fn finish_flushes_a_partial_prefix_without_decoding_it() {
        let mut redactor = redactor(&[SHORT_SECRET]);
        let mut budget = AggregateByteBudget::new(1_024, 1_024);
        assert_eq!(
            redactor.push(b"abc", &mut budget).expect("push must hold"),
            Vec::<u8>::new(),
        );
        assert_eq!(
            redactor.finish(&mut budget).expect("finish must flush"),
            b"abc",
        );
        assert_eq!(budget.raw_used(), 3);
        assert_eq!(budget.emitted_used(), 3);
        assert_eq!(
            redactor
                .finish(&mut budget)
                .expect_err("a stream can finish only once"),
            RedactionError::AlreadyFinished,
        );
    }

    #[test]
    fn arbitrary_non_utf8_bytes_are_matched_and_preserved_as_bytes() {
        let secret = vec![0xff, 0x00, 0xfe, 0x80, 0x81, 0x82, 0x83, 0x84];
        let mut redactor =
            StreamingRedactor::new(vec![secret.clone()]).expect("binary pattern must be valid");
        let mut budget = AggregateByteBudget::new(1_024, 1_024);
        let mut output = redactor
            .push(&[0xf5, 0x00, 0xff, 0x00], &mut budget)
            .expect("first binary chunk must redact");
        append(
            &mut output,
            redactor
                .push(&[0xfe, 0x80, 0x81, 0x82, 0x83, 0x84, 0x9f], &mut budget)
                .expect("second binary chunk must redact"),
        );
        append(
            &mut output,
            redactor.finish(&mut budget).expect("finish must flush"),
        );

        let mut expected = vec![0xf5, 0x00];
        expected.extend_from_slice(REDACTION_MARKER);
        expected.push(0x9f);
        assert_eq!(output, expected);
    }

    #[test]
    fn two_streams_share_one_raw_and_emitted_budget() {
        let mut stdout = redactor(&[SHORT_SECRET]);
        let mut stderr = redactor(&[SHORT_SECRET]);
        let mut budget = AggregateByteBudget::new(16, REDACTION_MARKER.len() * 2);

        assert_eq!(
            stdout
                .push(SHORT_SECRET, &mut budget)
                .expect("stdout must fit"),
            REDACTION_MARKER,
        );
        assert_eq!(
            stderr
                .push(SHORT_SECRET, &mut budget)
                .expect("stderr must fit"),
            REDACTION_MARKER,
        );
        assert_eq!(budget.raw_remaining(), 0);
        assert_eq!(budget.emitted_remaining(), 0);
    }

    #[test]
    fn raw_budget_is_reserved_before_redaction_and_failed_charge_is_atomic() {
        let mut stdout = redactor(&[SHORT_SECRET]);
        let mut stderr = redactor(&[SHORT_SECRET]);
        let mut budget = AggregateByteBudget::new(12, 1_024);

        assert_eq!(
            stdout
                .push(SHORT_SECRET, &mut budget)
                .expect("first raw chunk must fit"),
            REDACTION_MARKER,
        );
        assert_eq!(
            stderr
                .push(b"12345", &mut budget)
                .expect_err("aggregate raw bytes must be bounded"),
            RedactionError::RawBudgetExceeded,
        );
        assert_eq!(budget.raw_used(), SHORT_SECRET.len());
        assert_eq!(stderr.state, StreamState::Failed);
        assert!(stderr.patterns.is_empty());
        assert_eq!(stderr.pending.len(), 0);
        assert!(stderr.pending.bytes.iter().all(|byte| *byte == 0));
    }

    #[test]
    fn emitted_budget_applies_after_redaction_across_both_streams() {
        let mut stdout = redactor(&[SHORT_SECRET]);
        let mut stderr = redactor(&[SHORT_SECRET]);
        let mut budget = AggregateByteBudget::new(16, REDACTION_MARKER.len() * 2 - 1);

        assert_eq!(
            stdout
                .push(SHORT_SECRET, &mut budget)
                .expect("first marker must fit"),
            REDACTION_MARKER,
        );
        assert_eq!(
            stderr
                .push(SHORT_SECRET, &mut budget)
                .expect_err("second marker must exceed aggregate output"),
            RedactionError::EmittedBudgetExceeded,
        );
        assert_eq!(budget.raw_used(), 16);
        assert_eq!(budget.emitted_used(), REDACTION_MARKER.len());
        assert_eq!(stderr.state, StreamState::Failed);
        assert!(stderr.patterns.is_empty());
        assert!(stderr.pending.bytes.iter().all(|byte| *byte == 0));
    }

    #[test]
    fn finish_obeys_the_shared_emitted_budget_and_wipes_on_error() {
        let mut redactor = redactor(&[SHORT_SECRET]);
        let mut budget = AggregateByteBudget::new(7, 6);
        assert!(redactor
            .push(b"abcdefg", &mut budget)
            .expect("prefix must remain pending")
            .is_empty());

        assert_eq!(
            redactor
                .finish(&mut budget)
                .expect_err("flush must obey the output limit"),
            RedactionError::EmittedBudgetExceeded,
        );
        assert_eq!(budget.raw_used(), 7);
        assert_eq!(budget.emitted_used(), 0);
        assert_eq!(redactor.state, StreamState::Failed);
        assert!(redactor.patterns.is_empty());
        assert!(redactor.pending.bytes.iter().all(|byte| *byte == 0));
    }

    #[test]
    fn debug_and_errors_never_render_sensitive_pattern_bytes() {
        let secret = b"DO-NOT-PRINT-THIS".to_vec();
        let redactor = StreamingRedactor::new(vec![secret.clone()]).expect("pattern must be valid");
        assert!(!format!("{redactor:?}").contains("DO-NOT-PRINT-THIS"));
        assert!(!format!("{:?}", RedactionError::DuplicatePattern).contains("DO-NOT-PRINT-THIS"));
    }
}
