//! Text versions shared with the renderer (`src/document/textDelta.ts`).
//! Offsets count UTF-16 code units, as JavaScript strings do, and never split
//! a surrogate pair. The hash is cyrb53 over UTF-16 units plus the length.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TextDelta {
    pub from: usize,
    pub to: usize,
    pub insert: String,
}

pub fn text_hash(text: &str) -> String {
    let mut h1: u32 = 0xdead_beef;
    let mut h2: u32 = 0x41c6_ce57;
    let mut length = 0usize;
    for unit in text.encode_utf16() {
        length += 1;
        let unit = u32::from(unit);
        h1 = (h1 ^ unit).wrapping_mul(2_654_435_761);
        h2 = (h2 ^ unit).wrapping_mul(1_597_334_677);
    }
    h1 = (h1 ^ (h1 >> 16)).wrapping_mul(2_246_822_507);
    h1 ^= (h2 ^ (h2 >> 13)).wrapping_mul(3_266_489_909);
    h2 = (h2 ^ (h2 >> 16)).wrapping_mul(2_246_822_507);
    h2 ^= (h1 ^ (h1 >> 13)).wrapping_mul(3_266_489_909);
    let hash = (u64::from(h2 & 0x1f_ffff) << 32) | u64::from(h1);
    format!("{length:x}-{hash:x}")
}

/// Byte offset of a UTF-16 offset, rejecting offsets inside a character.
fn byte_offset(text: &str, units: usize) -> Result<usize, String> {
    let mut seen = 0usize;
    for (index, ch) in text.char_indices() {
        if seen == units {
            return Ok(index);
        }
        seen += ch.len_utf16();
        if seen > units {
            return Err("Text delta splits a character".into());
        }
    }
    if seen == units {
        Ok(text.len())
    } else {
        Err("Text delta is outside the base text".into())
    }
}

pub fn apply(base: &str, delta: &TextDelta) -> Result<String, String> {
    if delta.to < delta.from {
        return Err("Text delta range is inverted".into());
    }
    let from = byte_offset(base, delta.from)?;
    let to = from + byte_offset(&base[from..], delta.to - delta.from)?;
    let mut text = String::with_capacity(base.len() - (to - from) + delta.insert.len());
    text.push_str(&base[..from]);
    text.push_str(&delta.insert);
    text.push_str(&base[to..]);
    Ok(text)
}

/// The single replaced span that turns `base` into `next`, or None when equal.
pub fn single_span(base: &str, next: &str) -> Option<TextDelta> {
    if base == next {
        return None;
    }
    let (mut prefix_bytes, mut prefix_units) = (0usize, 0usize);
    for (a, b) in base.chars().zip(next.chars()) {
        if a != b {
            break;
        }
        prefix_bytes += a.len_utf8();
        prefix_units += a.len_utf16();
    }
    let (base_rest, next_rest) = (&base[prefix_bytes..], &next[prefix_bytes..]);
    let (mut suffix_bytes, mut suffix_units) = (0usize, 0usize);
    for (a, b) in base_rest.chars().rev().zip(next_rest.chars().rev()) {
        if a != b {
            break;
        }
        suffix_bytes += a.len_utf8();
        suffix_units += a.len_utf16();
    }
    let base_units: usize = base.encode_utf16().count();
    Some(TextDelta {
        from: prefix_units,
        to: base_units - suffix_units,
        insert: next[prefix_bytes..next.len() - suffix_bytes].to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_matches_renderer_vectors() {
        // Computed with src/document/textDelta.ts.
        assert_eq!(text_hash(""), "0-bdcb81aee8d83");
        assert_eq!(text_hash("a"), "1-1c2ba782c97901");
        assert_eq!(text_hash("hello world"), "b-b9417d15d1014");
        assert_eq!(text_hash("中文😀\r\nline"), "a-1428410d672b1c");
        assert_eq!(text_hash(&"x".repeat(1000)), "3e8-1a7942aee5273b");
    }

    #[test]
    fn single_span_round_trips_without_splitting_characters() {
        for (base, next) in [
            ("a😀b", "a😁b"),
            ("abcabc", "abc"),
            ("aaa", "aaaa"),
            ("", "新内容"),
            ("中文", ""),
            ("same", "same"),
        ] {
            match single_span(base, next) {
                Some(delta) => assert_eq!(apply(base, &delta).unwrap(), next),
                None => assert_eq!(base, next),
            }
        }
        let delta = single_span("a😀b", "a😁b").unwrap();
        assert_eq!((delta.from, delta.to, delta.insert.as_str()), (1, 3, "😁"));
    }

    #[test]
    fn rejects_offsets_inside_or_outside_text() {
        let inside = TextDelta { from: 2, to: 3, insert: String::new() };
        assert!(apply("a😀b", &inside).is_err());
        let outside = TextDelta { from: 0, to: 9, insert: String::new() };
        assert!(apply("abc", &outside).is_err());
    }
}
