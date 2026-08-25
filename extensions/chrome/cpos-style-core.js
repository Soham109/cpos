// CPOS Style Core — the single source of truth for the "modernize" restyle and
// the site theming. It exposes composable CSS-section builders, each scoped to a
// Codeforces / CSES site area, so coverage is exhaustive and the two features
// COMPOSE cleanly:
//
//   • modernize.js  consumes the STRUCTURAL sections — typography, spacing,
//                   rounded cards, table rhythm, control shapes. NO colours.
//   • site-theme.js consumes the COLOUR sections — backgrounds, borders, text,
//                   accents, verdict states. NO geometry.
//
// Structural tokens (radius/space/shadow/font/type scales) live here as flat
// defaults. Colour tokens are passed in from a themes.js theme object. Nothing
// here uses gradients; the aesthetic mirrors a flat VS Code panel / TUI.
//
// Everything is delivered as plain CSS text. The consumers own the <style>
// element lifecycle (stable id, set/remove on toggle, re-apply on change).
(function (root) {
  "use strict";

  // ---------------------------------------------------------------------------
  // STRUCTURAL TOKENS — geometry only, no colour. Shared by both features so the
  // shapes line up exactly whether you run modernize alone, theme alone, or both.
  // ---------------------------------------------------------------------------
  const STRUCT = {
    // Border-radius scale.
    radiusXs: "6px",
    radiusSm: "8px",
    radius: "12px",
    radiusLg: "16px",
    radiusPill: "999px",

    // Spacing scale (4px base).
    space1: "4px",
    space2: "8px",
    space3: "12px",
    space4: "16px",
    space5: "20px",
    space6: "24px",
    space8: "32px",

    // Soft, flat elevation (no glow, no gradient).
    shadow: "0 1px 2px rgba(0,0,0,0.06), 0 4px 16px rgba(0,0,0,0.04)",
    shadowLg: "0 2px 6px rgba(0,0,0,0.08), 0 12px 32px rgba(0,0,0,0.06)",

    // Hairline border used only for geometry purposes by modernize (a neutral
    // semi-transparent grey that reads fine on light and dark before theming).
    hairline: "rgba(128,128,128,0.18)",
    hairlineSoft: "rgba(128,128,128,0.12)",

    // Font stacks. (No webfont leads — MV3 CSP blocks them, so they'd silently
    // fall back to system-ui anyway; lead with it directly for one honest voice.)
    fontSans:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, system-ui, "Helvetica Neue", Arial, sans-serif',
    fontMono:
      'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',

    // Type scale.
    fsBase: "14.5px",
    fsSm: "13px",
    fsXs: "12px",
    fsLead: "16px",
    fsH1: "22px",
    fsH2: "19px",
    fsH3: "16.5px",
    lhBase: "1.62",
    lhProse: "1.72",
    lhTight: "1.3",

    // Motion.
    ease: "cubic-bezier(.4,0,.2,1)",
    durFast: "120ms",
    durMed: "180ms"
  };

  // Merge caller overrides over the structural defaults (kept for flexibility;
  // the consumers pass nothing today and just take the defaults).
  function tokens(overrides) {
    return Object.assign({}, STRUCT, overrides || {});
  }

  // ===========================================================================
  // STRUCTURAL SECTIONS (modernize) — Codeforces
  // Each returns a CSS string. They are concatenated by buildModernizeCf().
  // ===========================================================================

  function cfTypography(s) {
    return `
      /* ---- Typography base ---------------------------------------------- */
      body, .ttypography, button, input, select, textarea, table, .roundbox,
      #pageContent, .second-level-menu-list, .menu-list, .caption, .datatable {
        font-family: ${s.fontSans} !important;
        -webkit-font-smoothing: antialiased;
        text-rendering: optimizeLegibility;
      }
      body {
        font-size: ${s.fsBase} !important;
        line-height: ${s.lhBase} !important;
      }
      h1, h2, h3, h4, .title, .caption, .section-title, .header .title {
        font-weight: 700 !important;
        letter-spacing: -0.011em !important;
        line-height: ${s.lhTight} !important;
      }
      .problem-statement .header .title { font-size: ${s.fsH1} !important; }
      .ttypography h2 { font-size: ${s.fsH2} !important; }
      .ttypography h3 { font-size: ${s.fsH3} !important; }
      small, .small, .notice { font-size: ${s.fsSm} !important; }
    `;
  }

  function cfHeader(s) {
    return `
      /* ---- Top header + first/second-level menus ------------------------ */
      #header { padding: ${s.space2} 0 !important; }
      #header .menu-list-container { border-radius: 0 !important; }
      .menu-list-container, .second-level-menu, .second-level-menu-list, .menu-list {
        letter-spacing: 0.005em !important;
      }
      .menu-list-container, .second-level-menu, .second-level-menu-list {
        background-image: none !important;
      }
      .lang-chooser { padding: ${s.space1} ${s.space2} !important; }
      /* search / enter bars in the header */
      #header .enterForm input, #header form input { border-radius: ${s.radiusSm} !important; }
    `;
  }

  function cfRoundbox(s) {
    return `
      /* ---- Round boxes -> flat rounded cards; kill corner-image artifacts */
      .roundbox {
        border-radius: ${s.radiusLg} !important;
        border: 1px solid ${s.hairline} !important;
        box-shadow: ${s.shadow} !important;
        overflow: hidden !important;
        margin-bottom: ${s.space4} !important;
        background-clip: padding-box !important;
      }
      /* Corner / edge spacer images — globally, not just inside .roundbox.
         CF places .lt/.rt/.lb/.rb (corner imgs) and .left/.right/.top/.bottom
         (edge imgs) on roundboxes AND on legacy m1/m2/m3 skin chrome. */
      .lt, .rt, .lb, .rb,
      .roundbox > .left, .roundbox > .right {
        display: none !important;
      }
      .roundbox > .top, .roundbox > .bottom,
      .roundbox-lt, .roundbox-rt, .roundbox-lb, .roundbox-rb {
        height: 0 !important;
        border: none !important;
        background: none !important;
      }
      /* legacy skin corner images attached via background on body wrappers */
      #body, #header, .compact-problemset, .datatable,
      .menu-list-container, .second-level-menu, .second-level-menu-list, .menu-list {
        background-image: none !important;
      }
      .roundbox .caption.titled,
      .roundbox > .caption {
        padding: ${s.space3} ${s.space4} !important;
        font-size: ${s.fsLead} !important;
        margin: 0 !important;
      }
      .roundbox > .roundbox-body,
      .roundbox > div:not(.caption):not(.top):not(.bottom) {
        padding: ${s.space2} ${s.space4} ${s.space3} !important;
      }
    `;
  }

  function cfSidebar(s) {
    return `
      /* ---- Sidebar widgets ---------------------------------------------- */
      #sidebar > div, .sidebar .roundbox, .roundbox.sidebox {
        border-radius: ${s.radiusLg} !important;
        margin-bottom: ${s.space4} !important;
      }
      .sidebar .caption { padding: ${s.space3} ${s.space4} !important; }
      .personal-sidebar, .bottom-links {
        border-radius: ${s.radius} !important;
      }
      .bottom-links { padding: ${s.space3} ${s.space4} !important; }
    `;
  }

  function cfTables(s) {
    return `
      /* ---- Tables: problemset, standings, submissions, rating, friends -- */
      table.problems, .datatable table, table.rtable, table.standings,
      table.user-table, .status-frame-datatable {
        border-collapse: separate !important;
        border-spacing: 0 !important;
        width: 100% !important;
      }
      .datatable td, .datatable th,
      table.problems td, table.problems th,
      table.rtable td, table.rtable th,
      table.standings td, table.standings th,
      .status-frame-datatable td, .status-frame-datatable th {
        padding: ${s.space3} ${s.space4} !important;
        border-color: ${s.hairlineSoft} !important;
        vertical-align: middle !important;
      }
      .datatable th, table.problems th, table.standings th,
      .status-frame-datatable th {
        font-weight: 600 !important;
        letter-spacing: 0.02em !important;
        text-transform: none !important;
      }
      /* round the outer corners of the data area */
      .datatable { border-radius: ${s.radius} !important; overflow: hidden !important; }
    `;
  }

  function cfProblem(s) {
    return `
      /* ---- Problem statement + sample tests ----------------------------- */
      #pageContent { padding-top: ${s.space2} !important; }
      .problem-statement {
        padding: ${s.space5} ${s.space6} !important;
        border: 1px solid ${s.hairline} !important;
        border-radius: ${s.radius} !important;
        overflow: hidden !important;
      }
      .problem-statement .header { margin-bottom: ${s.space4} !important; }
      .problem-statement .section-title { margin-top: ${s.space4} !important; }
      .ttypography { line-height: ${s.lhProse} !important; }
      .ttypography p { margin: 0 0 ${s.space3} !important; }
      .problem-statement .property-title { font-weight: 600 !important; }
      /* sample tests as crisp rounded code cards */
      .sample-test { margin-top: ${s.space4} !important; }
      .sample-test .input, .sample-test .output {
        border-radius: ${s.radius} !important;
        overflow: hidden !important;
        border: 1px solid ${s.hairline} !important;
        margin-bottom: ${s.space3} !important;
      }
      .sample-test .title {
        padding: ${s.space2} ${s.space3} !important;
        font-weight: 600 !important;
        font-size: ${s.fsSm} !important;
      }
      .sample-test pre {
        border-radius: 0 !important;
        border: none !important;
        margin: 0 !important;
        padding: ${s.space3} ${s.space4} !important;
      }
      /* copy button CF injects on samples */
      .sample-test .input-output-copier {
        border-radius: ${s.radiusSm} !important;
        padding: ${s.space1} ${s.space2} !important;
      }
    `;
  }

  function cfContestStandings(s) {
    return `
      /* ---- Contest pages + standings ------------------------------------ */
      .contest-state-phase, .contestList .countdown { letter-spacing: 0.01em !important; }
      .standings .contestDirectionArrow { vertical-align: middle !important; }
      table.standings .cell-problem-name, table.standings td { white-space: nowrap !important; }
      .standings th { position: sticky; top: 0; }
      .roundbox.borderTopRound, .roundbox.borderBottomRound { border-radius: ${s.radiusLg} !important; }
    `;
  }

  function cfBlogComments(s) {
    return `
      /* ---- Blog entries + comments -------------------------------------- */
      .topic, .comment-form, .comments, .comment {
        border-radius: ${s.radius} !important;
      }
      .comment { padding: ${s.space3} ${s.space4} !important; margin-bottom: ${s.space3} !important; }
      .comment .info { font-size: ${s.fsSm} !important; }
      .topic .title { font-size: ${s.fsH2} !important; }
      .comment-form textarea { min-height: 120px !important; }
      .avatar img, .user-avatar img { border-radius: ${s.radiusSm} !important; }

      /* ---- Content images: tasteful rounded corners --------------------- */
      /* User-posted screenshots / announcement images / avatars inside prose
         and statement/blog/comment/profile containers. Scoped to reasonably-
         sized content images: excludes flag/verdict/rating icons and anything
         tiny via min-width/min-height, so small UI glyphs stay square. */
      .ttypography img, .problem-statement img, .topic img, .comment img,
      #pageContent .userbox img, #sidebar img, .roundbox .ttypography img {
        border-radius: ${s.radius} !important;
      }
      /* keep small icons / flags / verdict glyphs unrounded */
      .lang-chooser img,
      .ttypography img[width="16"], .ttypography img[height="16"],
      .verdict img, img.verdict, .verdict-format img,
      img[width="24"], img[height="24"],
      img[width="16"], img[height="16"], img[width="12"], img[height="12"] {
        border-radius: 0 !important;
      }
    `;
  }

  function cfControls(s) {
    return `
      /* ---- Buttons / inputs / forms ------------------------------------- */
      input[type="submit"], button, .submit, a.submit, .button {
        border-radius: ${s.radiusSm} !important;
        padding: ${s.space2} ${s.space4} !important;
        font-weight: 600 !important;
        border: 1px solid ${s.hairline} !important;
        transition: filter ${s.durFast} ${s.ease}, transform ${s.durFast} ${s.ease},
                    background ${s.durFast} ${s.ease};
        cursor: pointer !important;
      }
      input[type="submit"]:hover, button:hover, .submit:hover, .button:hover { filter: brightness(1.06); }
      input[type="submit"]:active, button:active, .submit:active { transform: translateY(1px); }
      input[type="text"], input[type="password"], input[type="number"],
      input[type="email"], input[type="search"], textarea, select {
        border-radius: ${s.radiusSm} !important;
        padding: ${s.space2} ${s.space3} !important;
        border: 1px solid ${s.hairline} !important;
        transition: border-color ${s.durFast} ${s.ease}, box-shadow ${s.durFast} ${s.ease};
      }
      textarea { line-height: ${s.lhBase} !important; }
      /* pagination */
      .pagination .page-index a, .pagination .page-index span {
        border-radius: ${s.radiusSm} !important;
        padding: ${s.space1} ${s.space3} !important;
        margin: 0 2px !important;
        transition: background ${s.durFast} ${s.ease};
      }
      .pagination ul { gap: 2px; }
    `;
  }

  function cfLinksCode(s) {
    return `
      /* ---- Links + code ------------------------------------------------- */
      a { text-decoration: none !important; }
      a:hover { text-decoration: underline !important; text-underline-offset: 2px !important; }
      pre, code, .prettyprint, tt, .source, .program-source {
        font-family: ${s.fontMono} !important;
        font-size: ${s.fsSm} !important;
      }
      pre, .prettyprint {
        border-radius: ${s.radius} !important;
        padding: ${s.space3} ${s.space4} !important;
        line-height: ${s.lhBase} !important;
      }
      code, tt {
        border-radius: ${s.radiusXs} !important;
        padding: 1px 5px !important;
      }
    `;
  }

  function cfFooter(s) {
    return `
      /* ---- Footer ------------------------------------------------------- */
      #footer {
        border-radius: ${s.radiusLg} ${s.radiusLg} 0 0 !important;
        padding: ${s.space4} !important;
        margin-top: ${s.space6} !important;
      }
    `;
  }

  // ===========================================================================
  // STRUCTURAL SECTIONS (modernize) — CSES
  // ===========================================================================

  function csesAll(s) {
    return `
      /* ---- CSES: typography --------------------------------------------- */
      body, table, input, select, textarea, button, .nav {
        font-family: ${s.fontSans} !important;
        -webkit-font-smoothing: antialiased;
      }
      body { font-size: 15px !important; line-height: ${s.lhBase} !important; }
      h1, h2, h3, .title-block {
        font-weight: 700 !important; letter-spacing: -0.011em !important;
        line-height: ${s.lhTight} !important;
      }
      #content, .content { max-width: 1080px !important; }

      /* ---- CSES: nav ---------------------------------------------------- */
      .nav {
        letter-spacing: 0.005em !important;
        padding: ${s.space2} ${s.space3} !important;
        border-radius: ${s.radius} !important;
        margin-bottom: ${s.space4} !important;
      }
      .nav a, .navlinks a {
        border-radius: ${s.radiusSm} !important;
        padding: ${s.space1} ${s.space2} !important;
        display: inline-block !important;
      }

      /* ---- CSES: task list + summary tables ----------------------------- */
      table.list, .summary-table, table {
        border-collapse: separate !important; border-spacing: 0 !important;
      }
      table td, table th {
        padding: ${s.space3} ${s.space3} !important;
        border-color: ${s.hairlineSoft} !important;
      }
      th { font-weight: 600 !important; }

      /* ---- CSES: statement / prose -------------------------------------- */
      .content { line-height: ${s.lhProse} !important; }
      /* content images get tasteful rounded corners; tiny icons stay square */
      .content img, #content img {
        border-radius: ${s.radiusSm} !important;
      }
      .content img[width="16"], .content img[height="16"],
      #content img[width="16"], #content img[height="16"] {
        border-radius: 0 !important;
      }

      /* ---- CSES: forms -------------------------------------------------- */
      a { text-decoration: none !important; }
      a:hover { text-decoration: underline !important; text-underline-offset: 2px !important; }
      input, select, textarea {
        border-radius: ${s.radiusSm} !important;
        padding: ${s.space2} ${s.space3} !important;
      }
      input[type="submit"], button {
        border-radius: ${s.radiusSm} !important;
        padding: ${s.space2} ${s.space4} !important;
        font-weight: 600 !important;
        transition: filter ${s.durFast} ${s.ease};
        cursor: pointer !important;
      }
      input[type="submit"]:hover, button:hover { filter: brightness(1.06); }

      /* ---- CSES: code --------------------------------------------------- */
      pre, code, .code {
        font-family: ${s.fontMono} !important;
        font-size: ${s.fsSm} !important;
      }
      pre, .code {
        border-radius: ${s.radius} !important;
        padding: ${s.space3} ${s.space4} !important;
        line-height: ${s.lhBase} !important;
      }
      code { border-radius: ${s.radiusXs} !important; padding: 1px 5px !important; }
    `;
  }

  // ===========================================================================
  // COLOUR SECTIONS (site-theme) — Codeforces
  // Each accepts a resolved palette `p` (see buildPalette()) and returns CSS.
  // GEOMETRY-FREE: backgrounds, borders, colour, accents only.
  // ===========================================================================

  function cfColorBase(p) {
    return `
      /* ---- Base canvas -------------------------------------------------- */
      html, body { background: ${p.bg} !important; color: ${p.fg} !important; }
      #body, #pageContent, .content-with-sidebar, .container, .main, #content,
      .compact-problemset, .datatable, #facebox .content {
        background: transparent !important; color: ${p.fg} !important;
      }
      hr { border-color: ${p.border} !important; background: ${p.border} !important; }
      ::selection { background: ${p.accentDim}; color: ${p.fg}; }

      /* links — explicitly EXCLUDE rating-tier handle colours */
      a:not([class*="user-"]):not(.rated-user),
      a:not([class*="user-"]):not(.rated-user):visited { color: ${p.accent} !important; }
      a:not([class*="user-"]):not(.rated-user):hover { color: ${p.accentDim} !important; }
    `;
  }

  function cfColorHeader(p) {
    return `
      /* ---- Header + menus ----------------------------------------------- */
      #header, .menu-list-container, .lang-chooser, .second-level-menu,
      ul.second-level-menu-list, ul.menu-list, #footer {
        background: ${p.panel} !important; color: ${p.fg} !important;
        border-color: ${p.border} !important;
      }
      .menu-list-container li, ul.menu-list li,
      .second-level-menu li, ul.second-level-menu-list li {
        background: transparent !important; color: ${p.fg} !important;
        border-color: ${p.border} !important;
      }
      ul.second-level-menu-list li a { color: ${p.fg} !important; }
      ul.second-level-menu-list li.current a, ul.second-level-menu-list li.selectedLava a { color: ${p.accent} !important; }
      #header a, ul.menu-list a, ul.second-level-menu-list a, .menu-list-container a,
      #footer a { color: ${p.fg} !important; }
      .menu-list-container .menu-list > li > a:hover,
      ul.second-level-menu-list > li > a:hover { background: ${p.hover} !important; color: ${p.accent} !important; }
      .menu-list-container .current,
      .menu-list-container .menu-list > li:hover,
      ul.menu-list > li:hover,
      .second-level-menu li:hover,
      ul.second-level-menu-list li:hover {
        background-color: ${p.hover} !important;
      }
      ul.second-level-menu-list li.current,
      ul.second-level-menu-list li.selectedLava,
      ul.second-level-menu-list li:hover,
      ul.second-level-menu-list li a:hover,
      .second-level-menu-list .backLava,
      .second-level-menu-list .leftLava {
        background-image: none !important;
      }
      ul.second-level-menu-list li.current,
      ul.second-level-menu-list li.selectedLava {
        background-color: ${p.hover} !important;
      }
      .second-level-menu-list .backLava,
      .second-level-menu-list .leftLava {
        background-color: transparent !important;
      }
      .menu-list-container .current,
      .menu-list-container .current > a,
      ul.second-level-menu-list .current,
      ul.second-level-menu-list .current > a,
      .second-level-menu .current, .second-level-menu .current > a {
        color: ${p.accent} !important;
      }

      /* ---- Brand logo on dark panels ----------------------------------- */
      /* The CF logo PNG has a baked-in white background — a backdrop can't fix it.
         Classic dark-mode image trick: invert(1) flips white→near-black and
         hue-rotate(180deg) approximately restores the brand colours so the logo
         reads cleanly without a jarring white chip. */
      #header a[href="/"], #header .logo > a {
        display: inline-flex !important;
        align-items: center !important;
        background: transparent !important;
        line-height: 0 !important;
      }
      #header a[href="/"] img, #header .logo > a img,
      #header img[alt="Codeforces"] {
        display: block !important;
        filter: invert(1) hue-rotate(180deg) !important;
        padding: 0 !important;
        border-radius: ${STRUCT.radiusSm} !important;
      }

      /* ---- Notification / envelope widgets ----------------------------- */
      /* CF's "You have +N! Wow!" envelope strip is login-gated; it has no own bg
         and shows the body white — theme the likely containers. */
      .notificationCount, .envelope, .personal-sidebar, #header .roundbox,
      .notice.notification, .alert-popup, .userPanel, .userPanel a,
      .top-links, a[href*="notifications"], .notification, .unread,
      #header .notice, #header .notification, #header .unread,
      #header div[style*="background"], #header span[style*="background"],
      #cookieNotice, .cookieNotice, .cookie-notice, .cookies, .cookie,
      .alert-info, .alert-success, .alert-warning {
        background: ${p.panel} !important; color: ${p.fg} !important;
        border-color: ${p.border} !important;
      }
      #header div[style*="background"] *,
      #header span[style*="background"] * {
        color: ${p.fg} !important;
      }
      #cookieNotice a, .cookieNotice a, .cookie-notice a,
      .cookies a, .cookie a, .alert-info a, .alert-success a, .alert-warning a {
        color: ${p.accent} !important;
      }
      #header div[style*="background"] a,
      #header span[style*="background"] a {
        color: ${p.accent} !important;
      }

      ul.second-level-menu-list {
        color: ${p.fg} !important;
      }
    `;
  }

  function cfColorPanels(p) {
    return `
      /* ---- Round boxes / panels / widgets ------------------------------- */
      .roundbox, .roundbox-body, .datatable, .info, .userbox, .topic,
      .comment-form, #sidebar > div, .sidebar, .roundbox.sidebox,
      .personal-sidebar, .bottom-links, .problemStatement, .problem-statement,
      .ttypography, .comments, .comment, .box, .diffData, .borderTopRound,
      .borderBottomRound {
        background: ${p.panel} !important; color: ${p.fg} !important;
        border-color: ${p.border} !important;
      }
      .roundbox .top, .roundbox .bottom, .roundbox .left, .roundbox .right,
      .roundbox .lt, .roundbox .rt, .roundbox .lb, .roundbox .rb {
        background: transparent !important; border-color: ${p.border} !important;
      }
      .caption, .roundbox .caption, .header .title, .title, .section-title,
      h1, h2, h3, h4 { color: ${p.fg} !important; }
      .caption.titled { background: ${p.panel2} !important; }
      .roundbox.minimized, .roundbox.minimized .caption,
      .roundbox .toggle, .roundbox .roundbox-lt,
      .roundbox .roundbox-rt, .roundbox .roundbox-lb,
      .roundbox .roundbox-rb {
        background-color: ${p.panel2} !important;
        border-color: ${p.border} !important;
        color: ${p.dim} !important;
      }
    `;
  }

  function cfColorTables(p) {
    return `
      /* ---- Tables ------------------------------------------------------- */
      /* CF leaves many data tables (gym, groups, edu, courses, problemset…) with
         WHITE row backgrounds + a WHITE native row-hover that our old, class-
         specific rules didn't cover — so untouched rows / the hovered row glared
         white on dark themes. Reset every table surface generically (scoped to
         direct table rows so page-layout tables aren't disturbed), then re-apply
         themed zebra + hover everywhere. */
      table, .datatable, .datatable table, table.problems, table.rtable,
      table.standings, table.user-table, .status-frame-datatable, table.list {
        background-color: transparent !important; border-color: ${p.border} !important;
        color: ${p.fg} !important;
      }
      table td, table th,
      .datatable td, .datatable th,
      .status-frame-datatable td, .status-frame-datatable th {
        border-color: ${p.border} !important; color: ${p.fg} !important;
        background-color: transparent !important;
      }
      /* reset row backgrounds (CF sets these on <tr>, which showed through the
         transparent cells as solid white) */
      table > tbody > tr, table > tr, .datatable tr, table.problems tr,
      table.standings tr, .status-frame-datatable tr { background-color: transparent !important; }
      /* Data cells need an explicit surface. Several CF pages, including the
         problemset, repaint alternate rows after load and the old transparent
         base let that white paint show through on dark themes. */
      html body .datatable table > tbody > tr > td,
      html body table.problems > tbody > tr > td,
      html body table.rtable > tbody > tr > td,
      html body table.standings > tbody > tr > td,
      html body .status-frame-datatable > tbody > tr > td,
      html body table.list > tbody > tr > td {
        background: ${p.panel} !important;
        color: ${p.fg} !important;
        border-color: ${p.border} !important;
      }
      /* themed zebra — CF adds class "dark" to ALTERNATE <td> (not <tr>) via JS
         (jQuery "tr:odd td".addClass("dark")); the light colour lives on
         .roundbox .dark (#F5F5F5, problemset) and .datatable .dark (#f8f8f8, gym/
         groups/edu). Target the td.dark class exactly — nth-child/tr rules miss it. */
      .roundbox .dark, .datatable .dark, td.dark, tr.dark > td,
      table.problems td.dark, .status-frame-datatable td.dark,
      table > tbody > tr:nth-child(even) > td { background: ${p.stripe} !important; }
      /* bulletproof: html body prefix guarantees we out-specify any CF rule */
      html body .roundbox td.dark, html body .datatable td.dark,
      html body table.problems td.dark, html body td.dark,
      html body .roundbox .dark, html body .datatable .dark,
      html body .datatable table > tbody > tr:nth-child(even) > td,
      html body table.problems > tbody > tr:nth-child(even) > td,
      html body table.rtable > tbody > tr:nth-child(even) > td,
      html body table.standings > tbody > tr:nth-child(even) > td,
      html body .status-frame-datatable > tbody > tr:nth-child(even) > td,
      html body table.list > tbody > tr:nth-child(even) > td {
        background: ${p.stripe} !important;
      }
      /* themed hover (generic — this is the rule that kills CF's white hover) */
      table > tbody > tr:hover > td, table > tr:hover > td,
      .datatable tr:hover > td, table.problems tr:hover > td,
      table.standings tr:hover > td, .status-frame-datatable tr:hover > td,
      table.list tr:hover > td { background: ${p.hover} !important; }
      /* header cells */
      th, .datatable th, table.problems th, table.standings th,
      .status-frame-datatable th, table.list th { background: ${p.panel2} !important; }
      /* accepted/solved problemset row tint without clobbering tier colours */
      .accepted-problem, tr.accepted-problem > td { background-color: ${p.okDim} !important; }

    `;
  }

  function cfColorProblem(p) {
    return `
      /* ---- Problem statement + sample tests ----------------------------- */
      .problem-statement .header, .problem-statement .property-title { color: ${p.fg} !important; }
      .problem-statement .MathJax,
      .problem-statement .MathJax *,
      .problem-statement .MathJax_Display,
      .problem-statement .MathJax_SVG,
      .problem-statement .MathJax_SVG *,
      .problem-statement .MathJax_SVG_Display,
      .problem-statement .mjx-chtml,
      .problem-statement .mjx-chtml *,
      .problem-statement mjx-container,
      .problem-statement mjx-container * {
        color: ${p.fg} !important;
      }
      .problem-statement .MathJax_SVG svg,
      .problem-statement .MathJax_SVG svg *,
      .problem-statement mjx-container svg,
      .problem-statement mjx-container svg * {
        fill: ${p.fg} !important;
        stroke: ${p.fg} !important;
      }
      .sample-test .input, .sample-test .output {
        background: ${p.panel2} !important; border-color: ${p.border} !important;
      }
      .sample-test .title { background: ${p.panel} !important; color: ${p.dim} !important; }
      .sample-test pre, .test-example-line {
        background: ${p.panel2} !important; color: ${p.fg} !important;
      }
      .sample-test .input-output-copier {
        background: ${p.panel} !important; color: ${p.dim} !important;
        border-color: ${p.border} !important; box-shadow: none !important;
      }
      .test-example-line-even { background: ${p.stripe} !important; }
    `;
  }

  function cfColorCode(p) {
    return `
      /* ---- Code --------------------------------------------------------- */
      pre, code, .prettyprint, tt, .source, .program-source {
        background: ${p.panel2} !important; color: ${p.fg} !important;
        border-color: ${p.border} !important;
      }
      .prettyprint .pln, .prettyprint .pun {
        color: ${p.fg} !important;
      }
      .prettyprint .com {
        color: ${p.dim} !important;
      }
    `;
  }

  function cfColorControls(p) {
    return `
      /* ---- Forms / buttons / pagination --------------------------------- */
      input, textarea, select {
        background: ${p.panel2} !important; color: ${p.fg} !important;
        border-color: ${p.border} !important;
      }
      input::placeholder, textarea::placeholder { color: ${p.dim} !important; }
      input:focus, textarea:focus, select:focus {
        border-color: ${p.accent} !important;
        box-shadow: 0 0 0 2px ${p.accentDim} !important;
        outline: none !important;
      }
      input[type="submit"], button, .submit, a.submit, .button {
        background: ${p.accentDim} !important; color: ${p.accentOn} !important;
        border-color: ${p.accentDim} !important;
      }
      button.close, button.toggle, .roundbox button.toggle,
      .input-output-copier, .spoiler-title button {
        background: ${p.panel2} !important; color: ${p.fg} !important;
        border-color: ${p.border} !important;
      }
      input[type="submit"]:hover, button:hover, .submit:hover, .button:hover {
        background: ${p.accent} !important; border-color: ${p.accent} !important;
      }
      button.close:hover, button.toggle:hover, .roundbox button.toggle:hover,
      .input-output-copier:hover, .spoiler-title button:hover {
        background: ${p.hover} !important; color: ${p.fg} !important;
        border-color: ${p.border} !important;
      }
      .pagination .page-index a, .pagination .page-index span {
        background: ${p.panel2} !important; border-color: ${p.border} !important;
        color: ${p.fg} !important;
      }
      .pagination .page-index.active span,
      .pagination .page-index a:hover {
        background: ${p.accentDim} !important; color: ${p.accentOn} !important;
        border-color: ${p.accentDim} !important;
      }
    `;
  }

  function cfColorMisc(p) {
    return `
      /* ---- Misc text + verdict states ----------------------------------- */
      .ttypography, .ttypography p, .text, .notice, span.legend, .small,
      .contest-state-phase, .comment, .comment .info, .info, .dim {
        color: ${p.fg} !important;
      }
      .notice, .small, .comment .info, .roundbox .bottom-links a { color: ${p.dim} !important; }
      .verdict-accepted, .cc-accepted, .accepted { color: ${p.ok} !important; }
      .verdict-rejected, .verdict-failed, .cc-rejected, .rejected { color: ${p.bad} !important; }
      .verdict-waiting, .verdict-testing { color: ${p.warn} !important; }
      .alert, .error { color: ${p.bad} !important; }
      .legendary-user-first-letter {
        color: ${p.fg} !important;
      }
    `;
  }

  // ===========================================================================
  // COLOUR SECTIONS (site-theme) — CSES
  // ===========================================================================

  function csesColor(p) {
    return `
      html, body { background: ${p.bg} !important; color: ${p.fg} !important; }
      .skeleton, #content, .content, #wrapper, .navlinks, .title-block, footer,
      .content-wrapper, .full, .narrow {
        background: transparent !important; color: ${p.fg} !important;
      }
      a:not(.task), a:visited:not(.task) { color: ${p.accent} !important; }
      a:not(.task):hover { color: ${p.accentDim} !important; }
      h1, h2, h3, h4, .title-block { color: ${p.fg} !important; }
      .nav { background: ${p.panel} !important; border-color: ${p.border} !important; }
      .nav, .nav a, .navlinks a { color: ${p.fg} !important; }
      .nav a:hover, .navlinks a:hover { background: ${p.hover} !important; color: ${p.accent} !important; }
      table, td, th, tr, table.list, .summary-table {
        border-color: ${p.border} !important; color: ${p.fg} !important;
        background: transparent !important;
      }
      tr:nth-child(even) td { background: ${p.stripe} !important; }
      tr:hover td { background: ${p.hover} !important; }
      th { background: ${p.panel2} !important; }
      pre, code, .code, .prettyprint {
        background: ${p.panel2} !important; color: ${p.fg} !important;
        border-color: ${p.border} !important;
      }
      input, textarea, select {
        background: ${p.panel2} !important; color: ${p.fg} !important;
        border-color: ${p.border} !important;
      }
      input:focus, textarea:focus, select:focus {
        border-color: ${p.accent} !important; outline: none !important;
        box-shadow: 0 0 0 2px ${p.accentDim} !important;
      }
      input[type="submit"], button {
        background: ${p.accentDim} !important; color: ${p.accentOn} !important;
        border-color: ${p.accentDim} !important;
      }
      input[type="submit"]:hover, button:hover {
        background: ${p.accent} !important; border-color: ${p.accent} !important;
      }
      /* score states — scope to .task-score so we don't recolour unrelated
         layout classes (CSES also uses bare .full on content wrappers). */
      .task-score.full, td.full, span.full { color: ${p.ok} !important; }
      .task-score.zero, td.zero, span.zero { color: ${p.bad} !important; }
      .controls a, .pager a {
        background: ${p.panel2} !important; border-color: ${p.border} !important;
        color: ${p.fg} !important;
      }
      .controls a:hover, .pager a:hover {
        background: ${p.accentDim} !important; color: ${p.accentOn} !important;
      }
    `;
  }

  // ===========================================================================
  // Colour helpers + palette resolution
  // ===========================================================================

  // Lighten/darken a #rrggbb hex by `amt` per channel (clamped). Falls back to
  // the input on any non-hex value (e.g. already-derived rgba).
  function shade(hex, amt) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
    r = Math.max(0, Math.min(255, r + amt));
    g = Math.max(0, Math.min(255, g + amt));
    b = Math.max(0, Math.min(255, b + amt));
    return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  }

  // Convert #rrggbb to rgba() with the given alpha (for subtle state tints).
  function alpha(hex, a) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  // Resolve a themes.js theme object into a flat, derived palette the colour
  // sections consume. Adds stripe/hover/okDim and an accentOn that always reads.
  function buildPalette(theme) {
    const t = theme || {};
    const isLight = (t.name || "").toLowerCase().indexOf("light") !== -1;
    const panel = t["--panel"] || "#161b22";
    return {
      bg: t["--bg"] || "#0d1117",
      panel: panel,
      panel2: t["--panel-2"] || "#1c2128",
      fg: t["--fg"] || "#e6edf3",
      dim: t["--dim"] || "#7d8590",
      border: t["--border"] || "#30363d",
      accent: t["--accent"] || "#6cb6ff",
      accentDim: t["--accent-dim"] || "#3b6ea5",
      accentOn: t["--accent-on"] || (isLight ? "#ffffff" : "#0d1117"),
      ok: t["--ok"] || "#3fb950",
      bad: t["--bad"] || "#f85149",
      warn: t["--warn"] || "#d29922",
      // Derived shades — direction flips for light themes so they stay subtle.
      stripe: isLight ? shade(panel, -8) : shade(panel, 8),
      hover: isLight ? shade(panel, -16) : shade(panel, 16),
      okDim: alpha(t["--ok"] || "#3fb950", isLight ? 0.1 : 0.14)
    };
  }

  // ===========================================================================
  // PUBLIC BUILDERS
  // ===========================================================================

  // STRUCTURAL CSS (no colour) — consumed by modernize.js.
  function buildModernizeCf(overrides) {
    const s = tokens(overrides);
    return [
      cfTypography(s), cfHeader(s), cfRoundbox(s), cfSidebar(s), cfTables(s),
      cfProblem(s), cfContestStandings(s), cfBlogComments(s), cfControls(s),
      cfLinksCode(s), cfFooter(s)
    ].join("\n");
  }
  function buildModernizeCses(overrides) {
    return csesAll(tokens(overrides));
  }

  // COLOUR CSS (no geometry) — consumed by site-theme.js. Pass a themes.js theme.
  function buildThemeCf(theme) {
    const p = buildPalette(theme);
    return [
      `:root{${rootVars(p)}}`,
      cfColorBase(p), cfColorHeader(p), cfColorPanels(p), cfColorTables(p),
      cfColorProblem(p), cfColorCode(p), cfColorControls(p), cfColorMisc(p)
    ].join("\n");
  }
  function buildThemeCses(theme) {
    const p = buildPalette(theme);
    return `:root{${rootVars(p)}}\n` + csesColor(p);
  }

  // Expose the resolved palette as :root vars too (handy for any inline tweaks
  // and for debugging in devtools).
  function rootVars(p) {
    return [
      `--c-bg:${p.bg}`, `--c-panel:${p.panel}`, `--c-panel2:${p.panel2}`,
      `--c-fg:${p.fg}`, `--c-dim:${p.dim}`, `--c-border:${p.border}`,
      `--c-accent:${p.accent}`, `--c-accent-dim:${p.accentDim}`,
      `--c-accent-on:${p.accentOn}`, `--c-ok:${p.ok}`, `--c-bad:${p.bad}`,
      `--c-warn:${p.warn}`, `--c-stripe:${p.stripe}`, `--c-hover:${p.hover}`,
      // Accent tint ladder (wash < soft < dim < accent) so a hint never needs full accent.
      `--c-accent-soft:${alpha(p.accent, 0.16)}`, `--c-accent-wash:${alpha(p.accent, 0.08)}`,
      // Shared geometry / type / elevation, so static injected CSS can use var(--radius)/etc
      // with a single source of truth (also mirrors the popup's STRUCT tokens).
      `--radius-sm:${STRUCT.radiusSm}`, `--radius:${STRUCT.radius}`, `--radius-lg:${STRUCT.radiusLg}`,
      `--radius-pill:${STRUCT.radiusPill}`, `--font-sans:${STRUCT.fontSans}`, `--font-mono:${STRUCT.fontMono}`,
      `--shadow-float:0 1px 2px ${alpha(p.fg, 0.09)}, 0 8px 24px ${alpha(p.fg, 0.13)}`
    ].join(";");
  }

  const api = {
    STRUCT,
    tokens,
    shade,
    alpha,
    buildPalette,
    // structural
    buildModernizeCf,
    buildModernizeCses,
    // colour
    buildThemeCf,
    buildThemeCses
  };

  root.CPOS_STYLE_CORE = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof self !== "undefined" ? self : this);
