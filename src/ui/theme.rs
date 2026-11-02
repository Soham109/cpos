use ratatui::style::{Color, Modifier, Style};
use ratatui::text::Span;
use ratatui::widgets::{Block, BorderType, Borders, Padding};

/// A color theme for the whole UI. Only the accent family changes between
/// presets; the background, foreground and semantic colors stay constant so
/// the app always reads cleanly.
#[derive(Debug, Clone, Copy)]
pub struct Theme {
    pub id: &'static str,
    pub bg: Color,
    pub fg: Color,
    pub dim: Color,
    pub border: Color,
    pub accent: Color,
    pub accent_dim: Color,
    pub highlight_bg: Color,
    pub success: Color,
    pub warning: Color,
    pub danger: Color,
}

impl Default for Theme {
    fn default() -> Self {
        Theme::from_name("purple")
    }
}

impl Theme {
    pub const NAMES: [&'static str; 9] = [
        "purple",
        "cyan",
        "green",
        "amber",
        "mono",
        "plain",
        "light",
        "catppuccin-mocha",
        "catppuccin-latte",
    ];

    pub fn from_name(name: &str) -> Theme {
        let base = Theme {
            id: "purple",
            bg: Color::Rgb(13, 13, 20),
            fg: Color::Rgb(214, 214, 224),
            dim: Color::Rgb(108, 108, 132),
            border: Color::Rgb(58, 58, 82),
            accent: Color::Rgb(180, 142, 255),
            accent_dim: Color::Rgb(124, 92, 191),
            highlight_bg: Color::Rgb(38, 32, 64),
            success: Color::Rgb(126, 231, 135),
            warning: Color::Rgb(227, 179, 65),
            danger: Color::Rgb(247, 118, 142),
        };

        match name {
            "cyan" => Theme {
                id: "cyan",
                accent: Color::Rgb(86, 182, 194),
                accent_dim: Color::Rgb(58, 130, 140),
                highlight_bg: Color::Rgb(20, 46, 52),
                ..base
            },
            "green" => Theme {
                id: "green",
                accent: Color::Rgb(126, 231, 135),
                accent_dim: Color::Rgb(82, 160, 92),
                highlight_bg: Color::Rgb(22, 46, 28),
                ..base
            },
            "amber" => Theme {
                id: "amber",
                accent: Color::Rgb(240, 180, 80),
                accent_dim: Color::Rgb(170, 122, 48),
                highlight_bg: Color::Rgb(48, 38, 16),
                ..base
            },
            "mono" => Theme {
                id: "mono",
                accent: Color::Rgb(200, 200, 214),
                accent_dim: Color::Rgb(130, 130, 150),
                highlight_bg: Color::Rgb(40, 40, 50),
                ..base
            },
            // Neutral grayscale — low contrast accents, no purple tint in the canvas.
            "plain" => Theme {
                id: "plain",
                bg: Color::Rgb(16, 16, 16),
                fg: Color::Rgb(224, 224, 224),
                dim: Color::Rgb(128, 128, 128),
                border: Color::Rgb(56, 56, 56),
                accent: Color::Rgb(208, 208, 208),
                accent_dim: Color::Rgb(152, 152, 152),
                highlight_bg: Color::Rgb(36, 36, 36),
                success: Color::Rgb(168, 196, 168),
                warning: Color::Rgb(196, 188, 156),
                danger: Color::Rgb(196, 160, 160),
            },
            // Light canvas — matches VS Code default light sidebar / editor feel.
            "light" => Theme {
                id: "light",
                bg: Color::Rgb(243, 243, 243),
                fg: Color::Rgb(51, 51, 51),
                dim: Color::Rgb(110, 110, 110),
                border: Color::Rgb(204, 204, 204),
                accent: Color::Rgb(0, 122, 204),
                accent_dim: Color::Rgb(0, 106, 177),
                highlight_bg: Color::Rgb(228, 238, 247),
                success: Color::Rgb(56, 142, 60),
                warning: Color::Rgb(184, 134, 11),
                danger: Color::Rgb(229, 20, 0),
            },
            // Catppuccin Mocha — dark, warm-tinted canvas with mauve accent.
            // Palette ref: https://github.com/catppuccin/catppuccin
            "catppuccin-mocha" => Theme {
                id: "catppuccin-mocha",
                bg: Color::Rgb(30, 30, 46),        // base
                fg: Color::Rgb(205, 214, 244),     // text
                dim: Color::Rgb(108, 112, 134),    // overlay0
                border: Color::Rgb(88, 91, 112),   // surface1
                accent: Color::Rgb(203, 166, 247), // mauve
                accent_dim: Color::Rgb(148, 112, 196), // mauve darkened
                highlight_bg: Color::Rgb(49, 50, 68),  // surface0
                success: Color::Rgb(166, 227, 161),    // green
                warning: Color::Rgb(249, 226, 175),    // yellow
                danger: Color::Rgb(243, 139, 168),     // red
            },
            // Catppuccin Latte — light, warm paper canvas with mauve accent.
            // Palette ref: https://github.com/catppuccin/catppuccin
            "catppuccin-latte" => Theme {
                id: "catppuccin-latte",
                bg: Color::Rgb(239, 241, 245),     // base
                fg: Color::Rgb(76, 79, 105),       // text
                dim: Color::Rgb(156, 160, 176),    // overlay0
                border: Color::Rgb(188, 192, 204), // surface1
                accent: Color::Rgb(136, 57, 239),  // mauve
                accent_dim: Color::Rgb(100, 40, 180), // mauve darkened
                highlight_bg: Color::Rgb(204, 208, 218), // surface0
                success: Color::Rgb(64, 160, 43),  // green
                warning: Color::Rgb(223, 142, 29), // yellow
                danger: Color::Rgb(210, 15, 57),   // red
            },
            _ => base,
        }
    }

    /// Problem rating color — grayscale steps on the plain theme, CF colors otherwise.
    pub fn rating_color(&self, rating: Option<u32>) -> Color {
        if self.id == "plain" {
            return match rating {
                Some(r) if r >= 2400 => Color::Rgb(220, 220, 220),
                Some(r) if r >= 1900 => Color::Rgb(200, 200, 200),
                Some(r) if r >= 1600 => Color::Rgb(180, 180, 180),
                Some(r) if r >= 1400 => Color::Rgb(168, 168, 168),
                Some(r) if r >= 1200 => Color::Rgb(156, 156, 156),
                Some(_) => Color::Rgb(144, 144, 144),
                None => Color::Rgb(120, 120, 120),
            };
        }
        Self::cf_rating_color(rating)
    }

    pub fn next_name(current: &str) -> &'static str {
        let idx = Self::NAMES.iter().position(|n| *n == current).unwrap_or(0);
        Self::NAMES[(idx + 1) % Self::NAMES.len()]
    }

    /// A rounded panel with a dim border, an accented title, and a little inner
    /// breathing room so content never sits flush against the border.
    pub fn panel(&self, title: &str) -> Block<'static> {
        Block::default()
            .title(Span::styled(
                format!(" {title} "),
                Style::default()
                    .fg(self.accent)
                    .add_modifier(Modifier::BOLD),
            ))
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .border_style(Style::default().fg(self.border))
            .style(Style::default().bg(self.bg))
            .padding(Padding::horizontal(1))
    }

    /// A panel whose border is accented (used for focused / important panels).
    pub fn panel_accent(&self, title: &str) -> Block<'static> {
        self.panel(title)
            .border_style(Style::default().fg(self.accent_dim))
    }

    pub fn selection(&self) -> Style {
        Style::default()
            .bg(self.highlight_bg)
            .fg(self.accent)
            .add_modifier(Modifier::BOLD)
    }

    pub fn title_style(&self) -> Style {
        Style::default()
            .fg(self.accent)
            .add_modifier(Modifier::BOLD)
    }

    pub fn dim_style(&self) -> Style {
        Style::default().fg(self.dim)
    }

    pub fn header_style(&self) -> Style {
        Style::default()
            .fg(self.accent_dim)
            .add_modifier(Modifier::BOLD)
    }

    /// Codeforces-style rating colors (full saturation).
    pub fn cf_rating_color(rating: Option<u32>) -> Color {
        match rating {
            Some(r) if r >= 2400 => Color::Rgb(255, 76, 76),
            Some(r) if r >= 2100 => Color::Rgb(255, 140, 60),
            Some(r) if r >= 1900 => Color::Rgb(195, 130, 240),
            Some(r) if r >= 1600 => Color::Rgb(110, 150, 255),
            Some(r) if r >= 1400 => Color::Rgb(80, 200, 215),
            Some(r) if r >= 1200 => Color::Rgb(126, 211, 135),
            Some(_) => Color::Rgb(160, 160, 170),
            None => Color::Rgb(120, 120, 132),
        }
    }
}
