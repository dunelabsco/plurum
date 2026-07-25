use std::fs::File;
use std::io::ErrorKind;

#[cfg(any(target_os = "macos", target_os = "linux"))]
use std::os::unix::fs::FileExt;
#[cfg(target_os = "windows")]
use std::os::windows::fs::FileExt;

use sha2::{Digest, Sha256};

use super::ExecutableAuthorityError;

#[cfg(target_os = "linux")]
const MAX_ELF_PROGRAM_HEADERS: u16 = 256;
#[cfg(target_os = "linux")]
const MAX_ELF_SECTION_HEADERS: u16 = 8_192;
#[cfg(target_os = "macos")]
const MAX_MACH_LOAD_COMMANDS: u32 = 4_096;
#[cfg(target_os = "macos")]
const MAX_MACH_LOAD_COMMAND_BYTES: u32 = 16 * 1024 * 1024;
#[cfg(target_os = "macos")]
const MAX_MACH_SECTIONS_PER_SEGMENT: u32 = 4_096;
#[cfg(target_os = "macos")]
const MAX_MACH_FAT_ARCHES: u32 = 2;
#[cfg(target_os = "macos")]
const MAX_MACH_FAT_ALIGNMENT_EXPONENT: u32 = 30;
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
const EXPECTED_MACH_CPU: u32 = 0x0100_0007;
#[cfg(all(target_os = "macos", target_arch = "x86_64"))]
const EXPECTED_MACH_CPU_SUBTYPE: u32 = 3;
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const EXPECTED_MACH_CPU: u32 = 0x0100_000c;
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
const EXPECTED_MACH_CPU_SUBTYPE: u32 = 0;
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
const MAX_PE_OFFSET: u64 = 16 * 1024 * 1024;
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
const MAX_PE_OPTIONAL_HEADER_BYTES: u16 = 4_096;
#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
const MAX_PE_SECTIONS: u16 = 96;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct NativeImageAttestation {
    digest: [u8; 32],
    #[cfg(target_os = "macos")]
    mapped_file_offset: u64,
}

impl NativeImageAttestation {
    pub(super) fn update_digest(self, digest: &mut Sha256) {
        digest.update(self.digest);
    }

    #[cfg(target_os = "macos")]
    pub(super) fn mapped_file_offset(self) -> u64 {
        self.mapped_file_offset
    }
}

struct DescriptorReader<'a> {
    file: &'a File,
    base: u64,
    len: u64,
}

impl DescriptorReader<'_> {
    #[cfg(target_os = "macos")]
    fn slice(&self, offset: u64, len: u64) -> Result<Self, ExecutableAuthorityError> {
        require_range(offset, len, self.len)?;
        let base = self
            .base
            .checked_add(offset)
            .ok_or(ExecutableAuthorityError::Unsafe)?;
        Ok(Self {
            file: self.file,
            base,
            len,
        })
    }

    fn read<const N: usize>(&self, offset: u64) -> Result<[u8; N], ExecutableAuthorityError> {
        let mut result = [0_u8; N];
        self.read_exact(offset, &mut result)?;
        Ok(result)
    }

    fn read_exact(
        &self,
        offset: u64,
        destination: &mut [u8],
    ) -> Result<(), ExecutableAuthorityError> {
        let length =
            u64::try_from(destination.len()).map_err(|_| ExecutableAuthorityError::Limit)?;
        require_range(offset, length, self.len)?;

        let mut completed = 0_usize;
        while completed < destination.len() {
            let completed_offset =
                u64::try_from(completed).map_err(|_| ExecutableAuthorityError::Limit)?;
            let relative_offset = offset
                .checked_add(completed_offset)
                .ok_or(ExecutableAuthorityError::Unsafe)?;
            let current_offset = self
                .base
                .checked_add(relative_offset)
                .ok_or(ExecutableAuthorityError::Unsafe)?;
            #[cfg(any(target_os = "macos", target_os = "linux"))]
            let read = self
                .file
                .read_at(&mut destination[completed..], current_offset);
            #[cfg(target_os = "windows")]
            let read = self
                .file
                .seek_read(&mut destination[completed..], current_offset);

            match read {
                Ok(0) => return Err(ExecutableAuthorityError::Unsafe),
                Ok(count) => {
                    completed = completed
                        .checked_add(count)
                        .ok_or(ExecutableAuthorityError::Limit)?;
                }
                Err(error) if error.kind() == ErrorKind::Interrupted => {}
                Err(_) => return Err(ExecutableAuthorityError::Unavailable),
            }
        }
        Ok(())
    }
}

pub(super) fn attest_native_image(
    file: &File,
    expected_len: u64,
) -> Result<NativeImageAttestation, ExecutableAuthorityError> {
    if file
        .metadata()
        .map_err(|_| ExecutableAuthorityError::Unavailable)?
        .len()
        != expected_len
    {
        return Err(ExecutableAuthorityError::Conflict);
    }
    let reader = DescriptorReader {
        file,
        base: 0,
        len: expected_len,
    };

    #[cfg(all(target_os = "windows", not(target_arch = "x86_64")))]
    {
        let _ = reader;
        Err(ExecutableAuthorityError::Unsupported)
    }
    #[cfg(any(
        target_os = "linux",
        target_os = "macos",
        all(target_os = "windows", target_arch = "x86_64")
    ))]
    {
        #[cfg(target_os = "linux")]
        let result = attest_elf64(&reader)?;
        #[cfg(target_os = "macos")]
        let result = attest_mach_o_image(&reader)?;
        #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
        let result = attest_pe32_plus(&reader)?;

        if file
            .metadata()
            .map_err(|_| ExecutableAuthorityError::Unavailable)?
            .len()
            != expected_len
        {
            return Err(ExecutableAuthorityError::Conflict);
        }
        Ok(result)
    }
}

#[cfg(target_os = "linux")]
fn attest_elf64(
    reader: &DescriptorReader<'_>,
) -> Result<NativeImageAttestation, ExecutableAuthorityError> {
    const ELF_HEADER_BYTES: u16 = 64;
    const PROGRAM_HEADER_BYTES: u16 = 56;
    const SECTION_HEADER_BYTES: u16 = 64;
    const ELF_CLASS_64: u8 = 2;
    const ELF_DATA_LITTLE_ENDIAN: u8 = 1;
    const ELF_VERSION_CURRENT: u8 = 1;
    const ET_EXEC: u16 = 2;
    const ET_DYN: u16 = 3;
    const PT_LOAD: u32 = 1;
    const PF_X: u32 = 1;
    const SHN_UNDEF: u16 = 0;

    let header = reader.read::<64>(0)?;
    if header[..4] != *b"\x7fELF"
        || header[4] != ELF_CLASS_64
        || header[5] != ELF_DATA_LITTLE_ENDIAN
        || header[6] != ELF_VERSION_CURRENT
        || header[7] != 0
        || header[8..16] != [0; 8]
    {
        return Err(ExecutableAuthorityError::Unsafe);
    }

    let image_type = little_u16(&header, 16);
    let machine = little_u16(&header, 18);
    let version = little_u32(&header, 20);
    let entry = little_u64(&header, 24);
    let program_offset = little_u64(&header, 32);
    let section_offset = little_u64(&header, 40);
    let header_bytes = little_u16(&header, 52);
    let program_entry_bytes = little_u16(&header, 54);
    let program_entries = little_u16(&header, 56);
    let section_entry_bytes = little_u16(&header, 58);
    let section_entries = little_u16(&header, 60);
    let section_names = little_u16(&header, 62);

    #[cfg(target_arch = "x86_64")]
    const EXPECTED_MACHINE: u16 = 62;
    #[cfg(target_arch = "aarch64")]
    const EXPECTED_MACHINE: u16 = 183;

    if !matches!(image_type, ET_EXEC | ET_DYN)
        || machine != EXPECTED_MACHINE
        || version != u32::from(ELF_VERSION_CURRENT)
        || entry == 0
        || header_bytes != ELF_HEADER_BYTES
        || program_entry_bytes != PROGRAM_HEADER_BYTES
        || program_entries == 0
        || program_entries > MAX_ELF_PROGRAM_HEADERS
        || program_offset < u64::from(ELF_HEADER_BYTES)
    {
        return Err(ExecutableAuthorityError::Unsafe);
    }
    require_table(
        program_offset,
        u64::from(program_entry_bytes),
        u64::from(program_entries),
        reader.len,
    )?;

    if section_offset == 0 {
        if section_entries != 0 || section_names != SHN_UNDEF {
            return Err(ExecutableAuthorityError::Unsafe);
        }
    } else {
        if section_entry_bytes != SECTION_HEADER_BYTES
            || section_entries == 0
            || section_entries > MAX_ELF_SECTION_HEADERS
            || (section_names != SHN_UNDEF && section_names >= section_entries)
        {
            return Err(ExecutableAuthorityError::Unsafe);
        }
        require_table(
            section_offset,
            u64::from(section_entry_bytes),
            u64::from(section_entries),
            reader.len,
        )?;
    }

    let mut has_load_segment = false;
    let mut entry_is_executable = false;
    let mut digest = Sha256::new();
    digest.update(b"plurum-native-image-elf64-v1\0");
    digest.update(machine.to_le_bytes());
    digest.update(image_type.to_le_bytes());
    digest.update(entry.to_le_bytes());
    digest.update(program_entries.to_le_bytes());
    digest.update(section_entries.to_le_bytes());

    for index in 0..program_entries {
        let offset = checked_table_entry(
            program_offset,
            u64::from(PROGRAM_HEADER_BYTES),
            u64::from(index),
        )?;
        let program = reader.read::<56>(offset)?;
        let kind = little_u32(&program, 0);
        let flags = little_u32(&program, 4);
        let file_offset = little_u64(&program, 8);
        let virtual_address = little_u64(&program, 16);
        let file_bytes = little_u64(&program, 32);
        let memory_bytes = little_u64(&program, 40);
        let alignment = little_u64(&program, 48);

        if kind == PT_LOAD {
            has_load_segment = true;
            if file_bytes > memory_bytes
                || !valid_power_of_two_alignment(alignment)
                || (alignment > 1 && file_offset % alignment != virtual_address % alignment)
            {
                return Err(ExecutableAuthorityError::Unsafe);
            }
            require_range(file_offset, file_bytes, reader.len)?;
            if flags & PF_X != 0
                && file_bytes > 0
                && value_in_span(entry, virtual_address, file_bytes)?
            {
                entry_is_executable = true;
            }
        }
        digest.update(kind.to_le_bytes());
        digest.update(flags.to_le_bytes());
        digest.update(file_offset.to_le_bytes());
        digest.update(virtual_address.to_le_bytes());
        digest.update(file_bytes.to_le_bytes());
        digest.update(memory_bytes.to_le_bytes());
        digest.update(alignment.to_le_bytes());
    }

    if !has_load_segment || !entry_is_executable {
        return Err(ExecutableAuthorityError::Unsafe);
    }
    Ok(finalize_attestation(digest))
}

#[cfg(target_os = "macos")]
fn attest_mach_o_image(
    reader: &DescriptorReader<'_>,
) -> Result<NativeImageAttestation, ExecutableAuthorityError> {
    const MH_MAGIC_64_LE: [u8; 4] = [0xcf, 0xfa, 0xed, 0xfe];
    const FAT_MAGIC: [u8; 4] = [0xca, 0xfe, 0xba, 0xbe];
    const FAT_MAGIC_64: [u8; 4] = [0xca, 0xfe, 0xba, 0xbf];

    match reader.read::<4>(0)? {
        MH_MAGIC_64_LE => attest_thin_mach_o64(reader),
        FAT_MAGIC => attest_fat_mach_o(reader, false),
        FAT_MAGIC_64 => attest_fat_mach_o(reader, true),
        _ => Err(ExecutableAuthorityError::Unsafe),
    }
}

#[cfg(target_os = "macos")]
#[derive(Clone, Copy)]
struct FatArch {
    cpu: u32,
    cpu_subtype: u32,
    offset: u64,
    bytes: u64,
    alignment_exponent: u32,
}

#[cfg(target_os = "macos")]
fn attest_fat_mach_o(
    reader: &DescriptorReader<'_>,
    is_64: bool,
) -> Result<NativeImageAttestation, ExecutableAuthorityError> {
    const FAT_HEADER_BYTES: u64 = 8;
    const FAT_ARCH_BYTES: u64 = 20;
    const FAT_ARCH_64_BYTES: u64 = 32;
    const FAT_MAGIC: [u8; 4] = [0xca, 0xfe, 0xba, 0xbe];
    const FAT_MAGIC_64: [u8; 4] = [0xca, 0xfe, 0xba, 0xbf];
    const MH_MAGIC_64_LE: [u8; 4] = [0xcf, 0xfa, 0xed, 0xfe];
    const MH_EXECUTE: u32 = 2;

    let header = reader.read::<8>(0)?;
    let arch_count = big_u32(&header, 4);
    let expected_magic = if is_64 { FAT_MAGIC_64 } else { FAT_MAGIC };
    if header[..4] != expected_magic || arch_count == 0 || arch_count > MAX_MACH_FAT_ARCHES {
        return Err(ExecutableAuthorityError::Unsafe);
    }
    let arch_bytes = if is_64 {
        FAT_ARCH_64_BYTES
    } else {
        FAT_ARCH_BYTES
    };
    let table_end = require_table(
        FAT_HEADER_BYTES,
        arch_bytes,
        u64::from(arch_count),
        reader.len,
    )?;

    let mut arches: [Option<FatArch>; MAX_MACH_FAT_ARCHES as usize] =
        [None; MAX_MACH_FAT_ARCHES as usize];
    let mut selected = None;
    let mut digest = Sha256::new();
    digest.update(if is_64 {
        b"plurum-native-image-fat-mach-o64-v1\0".as_slice()
    } else {
        b"plurum-native-image-fat-mach-o-v1\0".as_slice()
    });
    digest.update(arch_count.to_be_bytes());

    for index in 0..arch_count {
        let entry_offset = checked_table_entry(FAT_HEADER_BYTES, arch_bytes, u64::from(index))?;
        let arch = read_fat_arch(reader, entry_offset, is_64)?;
        if !supported_fat_architecture(arch.cpu, arch.cpu_subtype)
            || arch.bytes < 32
            || arch.offset < table_end
            || arch.alignment_exponent > MAX_MACH_FAT_ALIGNMENT_EXPONENT
        {
            return Err(ExecutableAuthorityError::Unsafe);
        }
        let alignment = 1_u64
            .checked_shl(arch.alignment_exponent)
            .ok_or(ExecutableAuthorityError::Unsafe)?;
        if arch.offset & (alignment - 1) != 0 {
            return Err(ExecutableAuthorityError::Unsafe);
        }
        require_range(arch.offset, arch.bytes, reader.len)?;

        for previous in arches.iter().flatten() {
            if previous.cpu == arch.cpu
                || ranges_overlap(previous.offset, previous.bytes, arch.offset, arch.bytes)?
            {
                return Err(ExecutableAuthorityError::Unsafe);
            }
        }

        let slice = reader.slice(arch.offset, arch.bytes)?;
        let thin_header = slice.read::<32>(0)?;
        if thin_header[..4] != MH_MAGIC_64_LE
            || little_u32(&thin_header, 4) != arch.cpu
            || little_u32(&thin_header, 8) != arch.cpu_subtype
            || little_u32(&thin_header, 12) != MH_EXECUTE
        {
            return Err(ExecutableAuthorityError::Unsafe);
        }

        if arch.cpu == EXPECTED_MACH_CPU {
            if selected.is_some()
                || mach_base_cpu_subtype(arch.cpu_subtype) != EXPECTED_MACH_CPU_SUBTYPE
            {
                return Err(ExecutableAuthorityError::Unsafe);
            }
            selected = Some((arch, slice));
        }
        arches[index as usize] = Some(arch);
        update_fat_arch_digest(&mut digest, arch);
    }

    let (selected_arch, selected_slice) = selected.ok_or(ExecutableAuthorityError::Unsupported)?;
    let thin = attest_thin_mach_o64(&selected_slice)?;
    update_fat_arch_digest(&mut digest, selected_arch);
    thin.update_digest(&mut digest);
    Ok(finalize_attestation_at_offset(digest, selected_arch.offset))
}

#[cfg(target_os = "macos")]
fn read_fat_arch(
    reader: &DescriptorReader<'_>,
    offset: u64,
    is_64: bool,
) -> Result<FatArch, ExecutableAuthorityError> {
    if is_64 {
        let bytes = reader.read::<32>(offset)?;
        if big_u32(&bytes, 28) != 0 {
            return Err(ExecutableAuthorityError::Unsafe);
        }
        Ok(FatArch {
            cpu: big_u32(&bytes, 0),
            cpu_subtype: big_u32(&bytes, 4),
            offset: big_u64(&bytes, 8),
            bytes: big_u64(&bytes, 16),
            alignment_exponent: big_u32(&bytes, 24),
        })
    } else {
        let bytes = reader.read::<20>(offset)?;
        Ok(FatArch {
            cpu: big_u32(&bytes, 0),
            cpu_subtype: big_u32(&bytes, 4),
            offset: u64::from(big_u32(&bytes, 8)),
            bytes: u64::from(big_u32(&bytes, 12)),
            alignment_exponent: big_u32(&bytes, 16),
        })
    }
}

#[cfg(target_os = "macos")]
fn supported_fat_architecture(cpu: u32, subtype: u32) -> bool {
    const CPU_X86_64: u32 = 0x0100_0007;
    const CPU_X86_64_ALL: u32 = 3;
    const CPU_ARM64: u32 = 0x0100_000c;
    const CPU_ARM64_ALL: u32 = 0;

    matches!(
        (cpu, mach_base_cpu_subtype(subtype)),
        (CPU_X86_64, CPU_X86_64_ALL) | (CPU_ARM64, CPU_ARM64_ALL)
    )
}

#[cfg(target_os = "macos")]
fn mach_base_cpu_subtype(subtype: u32) -> u32 {
    subtype & 0x00ff_ffff
}

#[cfg(target_os = "macos")]
fn update_fat_arch_digest(digest: &mut Sha256, arch: FatArch) {
    digest.update(arch.cpu.to_be_bytes());
    digest.update(arch.cpu_subtype.to_be_bytes());
    digest.update(arch.offset.to_be_bytes());
    digest.update(arch.bytes.to_be_bytes());
    digest.update(arch.alignment_exponent.to_be_bytes());
}

#[cfg(target_os = "macos")]
fn ranges_overlap(
    left_offset: u64,
    left_bytes: u64,
    right_offset: u64,
    right_bytes: u64,
) -> Result<bool, ExecutableAuthorityError> {
    let left_end = left_offset
        .checked_add(left_bytes)
        .ok_or(ExecutableAuthorityError::Unsafe)?;
    let right_end = right_offset
        .checked_add(right_bytes)
        .ok_or(ExecutableAuthorityError::Unsafe)?;
    Ok(left_offset < right_end && right_offset < left_end)
}

#[cfg(target_os = "macos")]
fn attest_thin_mach_o64(
    reader: &DescriptorReader<'_>,
) -> Result<NativeImageAttestation, ExecutableAuthorityError> {
    const MACH_HEADER_BYTES: u64 = 32;
    const MH_MAGIC_64_LE: [u8; 4] = [0xcf, 0xfa, 0xed, 0xfe];
    const MH_EXECUTE: u32 = 2;
    const LC_SEGMENT_64: u32 = 0x19;
    const LC_MAIN: u32 = 0x8000_0028;
    const SEGMENT_COMMAND_BYTES: u32 = 72;
    const SECTION_64_BYTES: u32 = 80;
    const ENTRY_POINT_COMMAND_BYTES: u32 = 24;
    const VM_PROT_EXECUTE: u32 = 4;

    let header = reader.read::<32>(0)?;
    let cpu = little_u32(&header, 4);
    let cpu_subtype = little_u32(&header, 8);
    let file_type = little_u32(&header, 12);
    let command_count = little_u32(&header, 16);
    let command_bytes = little_u32(&header, 20);
    if header[..4] != MH_MAGIC_64_LE
        || cpu != EXPECTED_MACH_CPU
        || mach_base_cpu_subtype(cpu_subtype) != EXPECTED_MACH_CPU_SUBTYPE
        || file_type != MH_EXECUTE
        || command_count == 0
        || command_count > MAX_MACH_LOAD_COMMANDS
        || command_bytes < command_count.saturating_mul(8)
        || command_bytes > MAX_MACH_LOAD_COMMAND_BYTES
    {
        return Err(ExecutableAuthorityError::Unsafe);
    }
    let commands_end = MACH_HEADER_BYTES
        .checked_add(u64::from(command_bytes))
        .ok_or(ExecutableAuthorityError::Unsafe)?;
    require_range(0, commands_end, reader.len)?;

    let mut cursor = MACH_HEADER_BYTES;
    let mut text_span = None;
    let mut entry_offset = None;
    let mut digest = Sha256::new();
    digest.update(b"plurum-native-image-mach-o64-v1\0");
    digest.update(cpu.to_le_bytes());
    digest.update(cpu_subtype.to_le_bytes());
    digest.update(command_count.to_le_bytes());
    digest.update(command_bytes.to_le_bytes());

    for _ in 0..command_count {
        let command_header = reader.read::<8>(cursor)?;
        let command = little_u32(&command_header, 0);
        let size = little_u32(&command_header, 4);
        if size < 8 || size & 7 != 0 {
            return Err(ExecutableAuthorityError::Unsafe);
        }
        let next = cursor
            .checked_add(u64::from(size))
            .ok_or(ExecutableAuthorityError::Unsafe)?;
        if next > commands_end {
            return Err(ExecutableAuthorityError::Unsafe);
        }

        if command == LC_SEGMENT_64 {
            if size < SEGMENT_COMMAND_BYTES {
                return Err(ExecutableAuthorityError::Unsafe);
            }
            let segment = reader.read::<72>(cursor)?;
            let sections = little_u32(&segment, 64);
            if sections > MAX_MACH_SECTIONS_PER_SEGMENT
                || SEGMENT_COMMAND_BYTES
                    .checked_add(
                        sections
                            .checked_mul(SECTION_64_BYTES)
                            .ok_or(ExecutableAuthorityError::Unsafe)?,
                    )
                    .ok_or(ExecutableAuthorityError::Unsafe)?
                    != size
            {
                return Err(ExecutableAuthorityError::Unsafe);
            }
            let file_offset = little_u64(&segment, 40);
            let file_bytes = little_u64(&segment, 48);
            let virtual_bytes = little_u64(&segment, 32);
            let initial_protection = little_u32(&segment, 60);
            if file_bytes > virtual_bytes {
                return Err(ExecutableAuthorityError::Unsafe);
            }
            require_range(file_offset, file_bytes, reader.len)?;
            if initial_protection & VM_PROT_EXECUTE != 0 && file_bytes > 0 {
                if segment[8..24] != text_segment_name() || text_span.is_some() {
                    return Err(ExecutableAuthorityError::Unsafe);
                }
                text_span = Some((file_offset, file_bytes));
            }
            digest.update(&segment[8..24]);
            digest.update(file_offset.to_le_bytes());
            digest.update(file_bytes.to_le_bytes());
            digest.update(virtual_bytes.to_le_bytes());
            digest.update(initial_protection.to_le_bytes());
            digest.update(sections.to_le_bytes());
        } else if command == LC_MAIN {
            if size != ENTRY_POINT_COMMAND_BYTES || entry_offset.is_some() {
                return Err(ExecutableAuthorityError::Unsafe);
            }
            let main = reader.read::<24>(cursor)?;
            entry_offset = Some(little_u64(&main, 8));
        }

        digest.update(command.to_le_bytes());
        digest.update(size.to_le_bytes());
        cursor = next;
    }

    let entry_offset = entry_offset.ok_or(ExecutableAuthorityError::Unsafe)?;
    let (text_offset, text_bytes) = text_span.ok_or(ExecutableAuthorityError::Unsafe)?;
    if cursor != commands_end
        || entry_offset >= reader.len
        || !value_in_span(entry_offset, text_offset, text_bytes)?
    {
        return Err(ExecutableAuthorityError::Unsafe);
    }
    digest.update(entry_offset.to_le_bytes());
    digest.update(text_offset.to_le_bytes());
    digest.update(text_bytes.to_le_bytes());
    Ok(finalize_attestation(digest))
}

#[cfg(target_os = "macos")]
const fn text_segment_name() -> [u8; 16] {
    [
        b'_', b'_', b'T', b'E', b'X', b'T', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]
}

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
fn attest_pe32_plus(
    reader: &DescriptorReader<'_>,
) -> Result<NativeImageAttestation, ExecutableAuthorityError> {
    const DOS_HEADER_BYTES: u64 = 64;
    const COFF_HEADER_BYTES: u64 = 24;
    const SECTION_HEADER_BYTES: u64 = 40;
    const PE32_PLUS_MINIMUM_BYTES: u16 = 112;
    const PE32_PLUS_MAGIC: u16 = 0x20b;
    const AMD64_MACHINE: u16 = 0x8664;
    const IMAGE_FILE_EXECUTABLE_IMAGE: u16 = 0x0002;
    const IMAGE_FILE_DLL: u16 = 0x2000;
    const IMAGE_SCN_CNT_CODE: u32 = 0x0000_0020;
    const IMAGE_SCN_MEM_EXECUTE: u32 = 0x2000_0000;
    const MAX_DATA_DIRECTORIES: u32 = 16;

    let dos = reader.read::<64>(0)?;
    if dos[..2] != *b"MZ" {
        return Err(ExecutableAuthorityError::Unsafe);
    }
    let pe_offset = u64::from(little_u32(&dos, 60));
    if !(DOS_HEADER_BYTES..=MAX_PE_OFFSET).contains(&pe_offset) || pe_offset & 3 != 0 {
        return Err(ExecutableAuthorityError::Unsafe);
    }
    let coff = reader.read::<24>(pe_offset)?;
    if coff[..4] != *b"PE\0\0" {
        return Err(ExecutableAuthorityError::Unsafe);
    }
    let machine = little_u16(&coff, 4);
    let section_count = little_u16(&coff, 6);
    let optional_bytes = little_u16(&coff, 20);
    let characteristics = little_u16(&coff, 22);
    if machine != AMD64_MACHINE
        || section_count == 0
        || section_count > MAX_PE_SECTIONS
        || !(PE32_PLUS_MINIMUM_BYTES..=MAX_PE_OPTIONAL_HEADER_BYTES).contains(&optional_bytes)
        || characteristics & IMAGE_FILE_EXECUTABLE_IMAGE == 0
        || characteristics & IMAGE_FILE_DLL != 0
    {
        return Err(ExecutableAuthorityError::Unsafe);
    }

    let optional_offset = pe_offset
        .checked_add(COFF_HEADER_BYTES)
        .ok_or(ExecutableAuthorityError::Unsafe)?;
    require_range(optional_offset, u64::from(optional_bytes), reader.len)?;
    let optional = reader.read::<112>(optional_offset)?;
    let entry_rva = little_u32(&optional, 16);
    let section_alignment = little_u32(&optional, 32);
    let file_alignment = little_u32(&optional, 36);
    let image_bytes = little_u32(&optional, 56);
    let header_bytes = little_u32(&optional, 60);
    let directory_count = little_u32(&optional, 108);
    if little_u16(&optional, 0) != PE32_PLUS_MAGIC
        || entry_rva == 0
        || !file_alignment.is_power_of_two()
        || !(512..=65_536).contains(&file_alignment)
        || !section_alignment.is_power_of_two()
        || section_alignment < file_alignment
        || image_bytes == 0
        || header_bytes == 0
        || u64::from(header_bytes) > reader.len
        || directory_count > MAX_DATA_DIRECTORIES
    {
        return Err(ExecutableAuthorityError::Unsafe);
    }
    let required_optional_bytes = u32::from(PE32_PLUS_MINIMUM_BYTES)
        .checked_add(
            directory_count
                .checked_mul(8)
                .ok_or(ExecutableAuthorityError::Unsafe)?,
        )
        .ok_or(ExecutableAuthorityError::Unsafe)?;
    if required_optional_bytes > u32::from(optional_bytes) {
        return Err(ExecutableAuthorityError::Unsafe);
    }

    let sections_offset = optional_offset
        .checked_add(u64::from(optional_bytes))
        .ok_or(ExecutableAuthorityError::Unsafe)?;
    let sections_end = require_table(
        sections_offset,
        SECTION_HEADER_BYTES,
        u64::from(section_count),
        reader.len,
    )?;
    if sections_end > u64::from(header_bytes) {
        return Err(ExecutableAuthorityError::Unsafe);
    }

    let mut entry_is_executable_code = false;
    let mut digest = Sha256::new();
    digest.update(b"plurum-native-image-pe32-plus-v1\0");
    digest.update(machine.to_le_bytes());
    digest.update(section_count.to_le_bytes());
    digest.update(entry_rva.to_le_bytes());
    digest.update(image_bytes.to_le_bytes());
    digest.update(header_bytes.to_le_bytes());

    for index in 0..section_count {
        let offset = checked_table_entry(sections_offset, SECTION_HEADER_BYTES, u64::from(index))?;
        let section = reader.read::<40>(offset)?;
        let virtual_bytes = little_u32(&section, 8);
        let virtual_address = little_u32(&section, 12);
        let file_bytes = little_u32(&section, 16);
        let file_offset = little_u32(&section, 20);
        let section_characteristics = little_u32(&section, 36);

        if file_bytes > 0 {
            if file_offset < header_bytes || file_offset & (file_alignment - 1) != 0 {
                return Err(ExecutableAuthorityError::Unsafe);
            }
            require_range(u64::from(file_offset), u64::from(file_bytes), reader.len)?;
        } else if file_offset != 0 {
            return Err(ExecutableAuthorityError::Unsafe);
        }
        let memory_span = virtual_bytes.max(file_bytes);
        let virtual_end = virtual_address
            .checked_add(memory_span)
            .ok_or(ExecutableAuthorityError::Unsafe)?;
        if virtual_address & (section_alignment - 1) != 0 || virtual_end > image_bytes {
            return Err(ExecutableAuthorityError::Unsafe);
        }
        if section_characteristics & (IMAGE_SCN_CNT_CODE | IMAGE_SCN_MEM_EXECUTE)
            == (IMAGE_SCN_CNT_CODE | IMAGE_SCN_MEM_EXECUTE)
            && file_bytes > 0
            && value_in_span(
                u64::from(entry_rva),
                u64::from(virtual_address),
                u64::from(file_bytes),
            )?
        {
            entry_is_executable_code = true;
        }

        digest.update(&section[..8]);
        digest.update(virtual_bytes.to_le_bytes());
        digest.update(virtual_address.to_le_bytes());
        digest.update(file_bytes.to_le_bytes());
        digest.update(file_offset.to_le_bytes());
        digest.update(section_characteristics.to_le_bytes());
    }

    if !entry_is_executable_code {
        return Err(ExecutableAuthorityError::Unsafe);
    }
    Ok(finalize_attestation(digest))
}

fn require_table(
    offset: u64,
    entry_bytes: u64,
    entries: u64,
    file_len: u64,
) -> Result<u64, ExecutableAuthorityError> {
    if entry_bytes == 0 || entries == 0 {
        return Err(ExecutableAuthorityError::Unsafe);
    }
    let bytes = entry_bytes
        .checked_mul(entries)
        .ok_or(ExecutableAuthorityError::Unsafe)?;
    require_range(offset, bytes, file_len)?;
    offset
        .checked_add(bytes)
        .ok_or(ExecutableAuthorityError::Unsafe)
}

fn checked_table_entry(
    offset: u64,
    entry_bytes: u64,
    index: u64,
) -> Result<u64, ExecutableAuthorityError> {
    offset
        .checked_add(
            entry_bytes
                .checked_mul(index)
                .ok_or(ExecutableAuthorityError::Unsafe)?,
        )
        .ok_or(ExecutableAuthorityError::Unsafe)
}

fn require_range(offset: u64, length: u64, file_len: u64) -> Result<(), ExecutableAuthorityError> {
    if offset.checked_add(length).is_none_or(|end| end > file_len) {
        Err(ExecutableAuthorityError::Unsafe)
    } else {
        Ok(())
    }
}

fn value_in_span(value: u64, start: u64, length: u64) -> Result<bool, ExecutableAuthorityError> {
    let end = start
        .checked_add(length)
        .ok_or(ExecutableAuthorityError::Unsafe)?;
    Ok(value >= start && value < end)
}

#[cfg(target_os = "linux")]
fn valid_power_of_two_alignment(value: u64) -> bool {
    value <= 1 || value.is_power_of_two()
}

#[cfg(any(
    target_os = "linux",
    all(target_os = "windows", target_arch = "x86_64")
))]
fn little_u16(bytes: &[u8], offset: usize) -> u16 {
    u16::from_le_bytes(
        bytes[offset..offset + 2]
            .try_into()
            .expect("fixed executable header field"),
    )
}

fn little_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(
        bytes[offset..offset + 4]
            .try_into()
            .expect("fixed executable header field"),
    )
}

#[cfg(target_os = "macos")]
fn big_u32(bytes: &[u8], offset: usize) -> u32 {
    u32::from_be_bytes(
        bytes[offset..offset + 4]
            .try_into()
            .expect("fixed universal executable header field"),
    )
}

#[cfg(target_os = "macos")]
fn big_u64(bytes: &[u8], offset: usize) -> u64 {
    u64::from_be_bytes(
        bytes[offset..offset + 8]
            .try_into()
            .expect("fixed universal executable header field"),
    )
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn little_u64(bytes: &[u8], offset: usize) -> u64 {
    u64::from_le_bytes(
        bytes[offset..offset + 8]
            .try_into()
            .expect("fixed executable header field"),
    )
}

fn finalize_attestation(digest: Sha256) -> NativeImageAttestation {
    #[cfg(target_os = "macos")]
    {
        finalize_attestation_at_offset(digest, 0)
    }
    #[cfg(not(target_os = "macos"))]
    {
        NativeImageAttestation {
            digest: finalize_digest(digest),
        }
    }
}

#[cfg(target_os = "macos")]
fn finalize_attestation_at_offset(
    digest: Sha256,
    mapped_file_offset: u64,
) -> NativeImageAttestation {
    NativeImageAttestation {
        digest: finalize_digest(digest),
        mapped_file_offset,
    }
}

fn finalize_digest(digest: Sha256) -> [u8; 32] {
    let bytes = digest.finalize();
    let mut result = [0_u8; 32];
    result.copy_from_slice(&bytes);
    result
}

#[cfg(test)]
mod tests {
    use std::fs::{self, OpenOptions};
    use std::io::{Seek, SeekFrom, Write};
    use std::sync::atomic::{AtomicU64, Ordering};

    use super::{attest_native_image, ExecutableAuthorityError};
    #[cfg(target_os = "macos")]
    use super::{EXPECTED_MACH_CPU, EXPECTED_MACH_CPU_SUBTYPE};

    static NEXT_FIXTURE: AtomicU64 = AtomicU64::new(1);

    fn temporary_image(name: &str, contents: &[u8]) -> std::fs::File {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "plurum-native-image-{name}-{}-{}-{}",
            std::process::id(),
            contents.len(),
            NEXT_FIXTURE.fetch_add(1, Ordering::Relaxed)
        ));
        let mut options = OpenOptions::new();
        options.read(true).write(true).create_new(true);
        let mut file = options.open(&path).expect("create native-image fixture");
        file.write_all(contents)
            .expect("write native-image fixture");
        file.flush().expect("flush native-image fixture");
        file.seek(SeekFrom::Start(0))
            .expect("rewind native-image fixture");
        fs::remove_file(path).expect("unlink native-image fixture");
        file
    }

    fn assert_rejected(contents: &[u8]) {
        let file = temporary_image("rejected", contents);
        assert!(matches!(
            attest_native_image(&file, contents.len() as u64),
            Err(ExecutableAuthorityError::Unsafe)
        ));
    }

    #[cfg(target_os = "macos")]
    fn assert_not_accepted(contents: &[u8]) {
        let file = temporary_image("not-accepted", contents);
        assert!(attest_native_image(&file, contents.len() as u64).is_err());
    }

    #[test]
    fn descriptor_attestation_rejects_scripts_text_and_magic_only_files() {
        for contents in [
            b"#!/bin/sh\nexit 0\n".as_slice(),
            b"plain executable text".as_slice(),
            b"@echo off\r\nexit /b 0\r\n".as_slice(),
            b"\x7fELF".as_slice(),
            b"MZ".as_slice(),
            b"\xcf\xfa\xed\xfe".as_slice(),
        ] {
            assert_rejected(contents);
        }
    }

    #[test]
    fn descriptor_attestation_accepts_the_current_compiled_test_image() {
        let path = std::env::current_exe().expect("resolve current native test image");
        let file = OpenOptions::new()
            .read(true)
            .open(path)
            .expect("open current native test image");
        let len = file
            .metadata()
            .expect("read current native test image metadata")
            .len();
        let attestation =
            attest_native_image(&file, len).expect("attest current compiled native test image");
        #[cfg(target_os = "macos")]
        assert_eq!(attestation.mapped_file_offset(), 0);
        #[cfg(not(target_os = "macos"))]
        let _ = attestation;
    }

    #[test]
    fn descriptor_attestation_rejects_a_wrong_architecture() {
        let path = std::env::current_exe().expect("resolve current native test image");
        let mut source = fs::read(path).expect("read current native test image");
        #[cfg(target_os = "linux")]
        source[18..20].fill(0);
        #[cfg(target_os = "macos")]
        source[4..8].fill(0);
        #[cfg(target_os = "windows")]
        {
            let pe_offset =
                u32::from_le_bytes(source[60..64].try_into().expect("DOS PE offset")) as usize;
            source[pe_offset + 4..pe_offset + 6].fill(0);
        }
        assert_rejected(&source);
    }

    #[test]
    fn descriptor_attestation_rejects_truncated_header_and_command_prefixes() {
        let path = std::env::current_exe().expect("resolve current native test image");
        let source = fs::read(path).expect("read current native test image");
        let required_prefix = source.len().min(4_096);
        for length in 0..required_prefix {
            assert_rejected(&source[..length]);
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn universal_mach_o_selects_the_one_exact_current_architecture() {
        let path = std::env::current_exe().expect("resolve current native test image");
        for is_64 in [false, true] {
            let current = fs::read(&path).expect("read current native test image");
            let (other_cpu, other_subtype) = other_mach_architecture();
            let other = minimal_thin_mach_header(other_cpu, other_subtype);
            let universal = fat_mach_fixture(
                is_64,
                &[
                    (other_cpu, other_subtype, other.as_slice()),
                    (
                        EXPECTED_MACH_CPU,
                        EXPECTED_MACH_CPU_SUBTYPE,
                        current.as_slice(),
                    ),
                ],
            );
            let selected_offset = if is_64 {
                u64::from_be_bytes(
                    universal[48..56]
                        .try_into()
                        .expect("FAT64 selected slice offset"),
                )
            } else {
                u64::from(u32::from_be_bytes(
                    universal[36..40]
                        .try_into()
                        .expect("FAT32 selected slice offset"),
                ))
            };
            let file = temporary_image("universal", &universal);
            let attestation = attest_native_image(&file, universal.len() as u64)
                .expect("attest compatible universal native test image");
            assert_eq!(attestation.mapped_file_offset(), selected_offset);
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn universal_mach_o_rejects_wrong_duplicate_and_truncated_architectures() {
        let (other_cpu, other_subtype) = other_mach_architecture();
        let other = minimal_thin_mach_header(other_cpu, other_subtype);
        let wrong_arch = fat_mach_fixture(false, &[(other_cpu, other_subtype, other.as_slice())]);
        assert_not_accepted(&wrong_arch);

        let current = minimal_thin_mach_header(EXPECTED_MACH_CPU, EXPECTED_MACH_CPU_SUBTYPE);
        let duplicate = fat_mach_fixture(
            false,
            &[
                (
                    EXPECTED_MACH_CPU,
                    EXPECTED_MACH_CPU_SUBTYPE,
                    current.as_slice(),
                ),
                (
                    EXPECTED_MACH_CPU,
                    EXPECTED_MACH_CPU_SUBTYPE,
                    current.as_slice(),
                ),
            ],
        );
        assert_rejected(&duplicate);

        let path = std::env::current_exe().expect("resolve current native test image");
        let source = fs::read(path).expect("read current native test image");
        let mut truncated = fat_mach_fixture(
            true,
            &[(
                EXPECTED_MACH_CPU,
                EXPECTED_MACH_CPU_SUBTYPE,
                source.as_slice(),
            )],
        );
        let selected_offset = usize::try_from(u64::from_be_bytes(
            truncated[16..24]
                .try_into()
                .expect("universal fixture offset"),
        ))
        .expect("universal fixture offset fits usize");
        let selected_bytes = usize::try_from(u64::from_be_bytes(
            truncated[24..32]
                .try_into()
                .expect("universal fixture size"),
        ))
        .expect("universal fixture size fits usize");
        truncated.truncate(selected_offset + selected_bytes - 1);
        assert_rejected(&truncated);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn universal_mach_o_rejects_malformed_tables_overlaps_and_reserved_fields() {
        let table_only = [0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 2, 0, 0, 0, 0];
        assert_rejected(&table_only);

        let (other_cpu, other_subtype) = other_mach_architecture();
        let other = minimal_thin_mach_header(other_cpu, other_subtype);
        let current = minimal_thin_mach_header(EXPECTED_MACH_CPU, EXPECTED_MACH_CPU_SUBTYPE);
        let mut overlap = fat_mach_fixture(
            false,
            &[
                (other_cpu, other_subtype, other.as_slice()),
                (
                    EXPECTED_MACH_CPU,
                    EXPECTED_MACH_CPU_SUBTYPE,
                    current.as_slice(),
                ),
            ],
        );
        let first_offset = overlap[16..20].to_vec();
        overlap[36..40].copy_from_slice(&first_offset);
        assert_rejected(&overlap);

        let mut reserved = fat_mach_fixture(
            true,
            &[(
                EXPECTED_MACH_CPU,
                EXPECTED_MACH_CPU_SUBTYPE,
                current.as_slice(),
            )],
        );
        reserved[36..40].copy_from_slice(&1_u32.to_be_bytes());
        assert_rejected(&reserved);
    }

    #[cfg(target_os = "macos")]
    fn other_mach_architecture() -> (u32, u32) {
        if EXPECTED_MACH_CPU == 0x0100_000c {
            (0x0100_0007, 3)
        } else {
            (0x0100_000c, 0)
        }
    }

    #[cfg(target_os = "macos")]
    fn minimal_thin_mach_header(cpu: u32, subtype: u32) -> [u8; 32] {
        let mut result = [0_u8; 32];
        result[..4].copy_from_slice(&[0xcf, 0xfa, 0xed, 0xfe]);
        result[4..8].copy_from_slice(&cpu.to_le_bytes());
        result[8..12].copy_from_slice(&subtype.to_le_bytes());
        result[12..16].copy_from_slice(&2_u32.to_le_bytes());
        result
    }

    #[cfg(target_os = "macos")]
    fn fat_mach_fixture(is_64: bool, slices: &[(u32, u32, &[u8])]) -> Vec<u8> {
        const ALIGNMENT_EXPONENT: u32 = 12;
        const ALIGNMENT: usize = 1 << ALIGNMENT_EXPONENT;

        assert!(!slices.is_empty());
        assert!(slices.len() <= 2);
        let entry_bytes = if is_64 { 32 } else { 20 };
        let table_bytes = 8 + entry_bytes * slices.len();
        let mut offsets = [0_usize; 2];
        let mut cursor = align_up(table_bytes, ALIGNMENT);
        for (index, (_, _, bytes)) in slices.iter().enumerate() {
            offsets[index] = cursor;
            cursor = align_up(
                cursor
                    .checked_add(bytes.len())
                    .expect("universal fixture size"),
                ALIGNMENT,
            );
        }

        let mut result = vec![0_u8; cursor];
        result[..4].copy_from_slice(if is_64 {
            &[0xca, 0xfe, 0xba, 0xbf]
        } else {
            &[0xca, 0xfe, 0xba, 0xbe]
        });
        result[4..8].copy_from_slice(
            &u32::try_from(slices.len())
                .expect("bounded universal fixture slice count")
                .to_be_bytes(),
        );
        for (index, (cpu, subtype, bytes)) in slices.iter().enumerate() {
            let descriptor = 8 + entry_bytes * index;
            result[descriptor..descriptor + 4].copy_from_slice(&cpu.to_be_bytes());
            result[descriptor + 4..descriptor + 8].copy_from_slice(&subtype.to_be_bytes());
            if is_64 {
                result[descriptor + 8..descriptor + 16].copy_from_slice(
                    &u64::try_from(offsets[index])
                        .expect("universal fixture offset")
                        .to_be_bytes(),
                );
                result[descriptor + 16..descriptor + 24].copy_from_slice(
                    &u64::try_from(bytes.len())
                        .expect("universal fixture length")
                        .to_be_bytes(),
                );
                result[descriptor + 24..descriptor + 28]
                    .copy_from_slice(&ALIGNMENT_EXPONENT.to_be_bytes());
            } else {
                result[descriptor + 8..descriptor + 12].copy_from_slice(
                    &u32::try_from(offsets[index])
                        .expect("universal fixture offset")
                        .to_be_bytes(),
                );
                result[descriptor + 12..descriptor + 16].copy_from_slice(
                    &u32::try_from(bytes.len())
                        .expect("universal fixture length")
                        .to_be_bytes(),
                );
                result[descriptor + 16..descriptor + 20]
                    .copy_from_slice(&ALIGNMENT_EXPONENT.to_be_bytes());
            }
            let end = offsets[index] + bytes.len();
            result[offsets[index]..end].copy_from_slice(bytes);
        }
        result
    }

    #[cfg(target_os = "macos")]
    fn align_up(value: usize, alignment: usize) -> usize {
        value
            .checked_add(alignment - 1)
            .expect("universal fixture alignment")
            & !(alignment - 1)
    }
}
