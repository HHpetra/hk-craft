//! Answer OSC 10/11 and DEC 2031 from the PTY owner so OpenTUI/OpenCode
//! can follow HK-Craft's light/dark theme without waiting on the WebView.

const MAX_LEFTOVER: usize = 128;
const BEL: char = '\u{0007}';
const OSC_10: u8 = 10;
const OSC_11: u8 = 11;

/// xterm palettes in `src/lib/theme.ts` — keep fg/bg in sync.
pub const DARK: ThemeColors = ThemeColors {
    light: false,
    fg: "#ebdbb2",
    bg: "#282828",
};
pub const LIGHT: ThemeColors = ThemeColors {
    light: true,
    fg: "#54433a",
    bg: "#f5f1ec",
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ThemeColors {
    pub light: bool,
    pub fg: &'static str,
    pub bg: &'static str,
}

#[derive(Debug, Default)]
pub struct ThemeReplyState {
    pub rest: String,
    pub mode_2031: bool,
}

pub fn colors_for(theme: &str) -> ThemeColors {
    if theme.eq_ignore_ascii_case("light") {
        LIGHT
    } else {
        DARK
    }
}

pub fn hex_to_osc_rgb(hex: &str) -> String {
    let h = hex.trim_start_matches('#');
    let r = h.get(0..2).unwrap_or("00");
    let g = h.get(2..4).unwrap_or("00");
    let b = h.get(4..6).unwrap_or("00");
    format!("rgb:{r}{r}/{g}{g}/{b}{b}")
}

pub fn osc_color_reply(slot: u8, hex: &str) -> String {
    format!("\x1b]{slot};{}\x1b\\", hex_to_osc_rgb(hex))
}

pub fn csi_997(light: bool) -> &'static str {
    if light {
        "\x1b[?997;2n"
    } else {
        "\x1b[?997;1n"
    }
}

pub fn decrpm_2031(set: bool) -> String {
    let ps = if set { 1 } else { 2 };
    format!("\x1b[?2031;{ps}$y")
}

/// Scan PTY output for color-scheme queries. Queries stay in `chunk` (xterm
/// consumes them); returned bytes are written back to the child immediately.
pub fn scan_theme_queries(chunk: &str, colors: ThemeColors, state: &mut ThemeReplyState) -> String {
    let mut input = String::with_capacity(state.rest.len() + chunk.len());
    input.push_str(&state.rest);
    input.push_str(chunk);
    let (complete, rest) = split_incomplete(&input);
    state.rest = rest.to_string();
    let mut replies = String::new();
    let mut i = 0;
    while i < complete.len() {
        let rest = &complete[i..];
        if !rest.starts_with('\x1b') {
            i += next_char_len(rest);
            continue;
        }
        match parse_escape_span(rest) {
            Span::Incomplete => break,
            Span::Complete(n) => {
                if let Some(action) = parse_action(&rest[..n]) {
                    apply_action(action, colors, state, &mut replies);
                }
                i += n;
            }
        }
    }
    replies
}

enum Span {
    Complete(usize),
    Incomplete,
}

enum Action {
    Osc(&'static [u8]),
    Mode2031(bool),
    Decrpm2031,
}

fn split_incomplete(input: &str) -> (&str, &str) {
    let mut i = 0;
    while i < input.len() {
        let rest = &input[i..];
        if !rest.starts_with('\x1b') {
            i += next_char_len(rest);
            continue;
        }
        match parse_escape_span(rest) {
            Span::Complete(n) => i += n,
            Span::Incomplete => {
                if rest.len() > MAX_LEFTOVER {
                    i += 1;
                    continue;
                }
                return (&input[..i], rest);
            }
        }
    }
    (input, "")
}

fn parse_escape_span(s: &str) -> Span {
    let bytes = s.as_bytes();
    if bytes.len() < 2 {
        return Span::Incomplete;
    }
    match bytes[1] {
        b']' => osc_span(s),
        b'[' => csi_span(bytes),
        _ => Span::Complete(2),
    }
}

fn osc_span(s: &str) -> Span {
    let after = &s[2..];
    if let Some(pos) = after.find(BEL) {
        return Span::Complete(2 + pos + 1);
    }
    if let Some(pos) = after.find("\x1b\\") {
        return Span::Complete(2 + pos + 2);
    }
    Span::Incomplete
}

fn csi_span(bytes: &[u8]) -> Span {
    for (idx, &c) in bytes[2..].iter().enumerate() {
        if (0x40..=0x7E).contains(&c) {
            return Span::Complete(2 + idx + 1);
        }
        if c == 0x1b {
            return Span::Complete(idx + 2);
        }
    }
    Span::Incomplete
}

fn parse_action(seq: &str) -> Option<Action> {
    let bytes = seq.as_bytes();
    if bytes.len() >= 3 && bytes[1] == b']' {
        return osc_query_action(osc_body(seq)?);
    }
    if bytes.len() >= 3 && bytes[1] == b'[' {
        return csi_action(seq);
    }
    None
}

fn osc_body(seq: &str) -> Option<&str> {
    let after = seq.get(2..)?;
    if let Some(body) = after.strip_suffix(BEL) {
        return Some(body);
    }
    after.strip_suffix("\x1b\\")
}

fn osc_query_action(body: &str) -> Option<Action> {
    match body {
        "10;?" => Some(Action::Osc(&[OSC_10])),
        "11;?" => Some(Action::Osc(&[OSC_11])),
        "10;?;?" => Some(Action::Osc(&[OSC_10, OSC_11])),
        _ => None,
    }
}

fn csi_action(seq: &str) -> Option<Action> {
    let inner = seq.strip_prefix("\x1b[")?;
    if let Some(params) = inner.strip_suffix("$y") {
        let params = params.strip_prefix('?')?;
        return has_mode(params, "2031").then_some(Action::Decrpm2031);
    }
    let final_byte = *inner.as_bytes().last()?;
    if final_byte != b'h' && final_byte != b'l' {
        return None;
    }
    let params = inner.get(..inner.len() - 1)?.strip_prefix('?')?;
    if !has_mode(params, "2031") {
        return None;
    }
    Some(Action::Mode2031(final_byte == b'h'))
}

fn has_mode(params: &str, mode: &str) -> bool {
    params.split(';').any(|part| {
        let trimmed = part.trim_start_matches('0');
        if trimmed.is_empty() {
            mode == "0"
        } else {
            trimmed == mode
        }
    })
}

fn apply_action(action: Action, colors: ThemeColors, state: &mut ThemeReplyState, replies: &mut String) {
    match action {
        Action::Osc(slots) => {
            for slot in slots {
                let hex = if *slot == OSC_10 { colors.fg } else { colors.bg };
                replies.push_str(&osc_color_reply(*slot, hex));
            }
        }
        Action::Mode2031(enable) => {
            state.mode_2031 = enable;
            if enable {
                replies.push_str(csi_997(colors.light));
            }
        }
        Action::Decrpm2031 => replies.push_str(&decrpm_2031(state.mode_2031)),
    }
}

fn next_char_len(s: &str) -> usize {
    s.chars().next().map(char::len_utf8).unwrap_or(1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scan(chunk: &str, colors: ThemeColors) -> (String, ThemeReplyState) {
        let mut state = ThemeReplyState::default();
        let replies = scan_theme_queries(chunk, colors, &mut state);
        (replies, state)
    }

    #[test]
    fn hex_to_osc_rgb_matches_frontend() {
        assert_eq!(hex_to_osc_rgb("#282828"), "rgb:2828/2828/2828");
        assert_eq!(hex_to_osc_rgb("#f5f1ec"), "rgb:f5f5/f1f1/ecec");
        assert_eq!(hex_to_osc_rgb("#ebdbb2"), "rgb:ebeb/dbdb/b2b2");
        assert_eq!(hex_to_osc_rgb("#54433a"), "rgb:5454/4343/3a3a");
    }

    #[test]
    fn colors_for_light_and_dark() {
        assert_eq!(colors_for("light"), LIGHT);
        assert_eq!(colors_for("LIGHT"), LIGHT);
        assert_eq!(colors_for("dark"), DARK);
        assert_eq!(colors_for(""), DARK);
    }

    #[test]
    fn osc_11_bel_replies_background() {
        let (replies, _) = scan("\x1b]11;?\x07", LIGHT);
        assert_eq!(replies, osc_color_reply(11, LIGHT.bg));
    }

    #[test]
    fn osc_10_st_replies_foreground() {
        let (replies, _) = scan("\x1b]10;?\x1b\\", DARK);
        assert_eq!(replies, osc_color_reply(10, DARK.fg));
    }

    #[test]
    fn osc_10_and_11_same_chunk() {
        let chunk = "\x1b]10;?\x07\x1b]11;?\x07";
        let (replies, _) = scan(chunk, LIGHT);
        assert_eq!(
            replies,
            format!(
                "{}{}",
                osc_color_reply(10, LIGHT.fg),
                osc_color_reply(11, LIGHT.bg)
            )
        );
    }

    #[test]
    fn osc_10_combined_query_replies_both() {
        let (replies, _) = scan("\x1b]10;?;?\x07", DARK);
        assert_eq!(
            replies,
            format!(
                "{}{}",
                osc_color_reply(10, DARK.fg),
                osc_color_reply(11, DARK.bg)
            )
        );
    }

    #[test]
    fn incomplete_osc_held_across_chunks() {
        let mut state = ThemeReplyState::default();
        let first = scan_theme_queries("\x1b]11;?", LIGHT, &mut state);
        assert!(first.is_empty());
        assert_eq!(state.rest, "\x1b]11;?");
        let second = scan_theme_queries("\x07", LIGHT, &mut state);
        assert_eq!(second, osc_color_reply(11, LIGHT.bg));
        assert!(state.rest.is_empty());
    }

    #[test]
    fn st_split_across_chunks() {
        let mut state = ThemeReplyState::default();
        let first = scan_theme_queries("\x1b]10;?\x1b", DARK, &mut state);
        assert!(first.is_empty());
        let second = scan_theme_queries("\\", DARK, &mut state);
        assert_eq!(second, osc_color_reply(10, DARK.fg));
    }

    #[test]
    fn mode_2031_seeds_997_for_light_and_dark() {
        let (replies, state) = scan("\x1b[?2031h", LIGHT);
        assert_eq!(replies, csi_997(true));
        assert!(state.mode_2031);

        let (replies, state) = scan("\x1b[?2031h", DARK);
        assert_eq!(replies, csi_997(false));
        assert!(state.mode_2031);
    }

    #[test]
    fn mode_2031_disable_unsubscribes() {
        let mut state = ThemeReplyState {
            mode_2031: true,
            rest: String::new(),
        };
        let replies = scan_theme_queries("\x1b[?2031l", LIGHT, &mut state);
        assert!(replies.is_empty());
        assert!(!state.mode_2031);
    }

    #[test]
    fn combined_csi_still_catches_2031() {
        let (replies, state) = scan("\x1b[?2004;2031h", LIGHT);
        assert_eq!(replies, csi_997(true));
        assert!(state.mode_2031);

        let (replies, _) = scan("\x1b[?2004h", LIGHT);
        assert!(replies.is_empty());
    }

    #[test]
    fn incomplete_csi_held_across_chunks() {
        let mut state = ThemeReplyState::default();
        let first = scan_theme_queries("\x1b[?203", DARK, &mut state);
        assert!(first.is_empty());
        let second = scan_theme_queries("1h", DARK, &mut state);
        assert_eq!(second, csi_997(false));
        assert!(state.mode_2031);
    }

    #[test]
    fn decrpm_2031_reports_set_or_reset() {
        let (replies, _) = scan("\x1b[?2031$y", LIGHT);
        assert_eq!(replies, decrpm_2031(false));

        let mut state = ThemeReplyState {
            mode_2031: true,
            rest: String::new(),
        };
        let replies = scan_theme_queries("\x1b[?2031$y", LIGHT, &mut state);
        assert_eq!(replies, decrpm_2031(true));
    }

    #[test]
    fn unrelated_output_is_ignored() {
        let (replies, state) = scan("hello \x1b[2J world", LIGHT);
        assert!(replies.is_empty());
        assert!(!state.mode_2031);
        assert!(state.rest.is_empty());
    }
}
