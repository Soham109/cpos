(function () {
  const captions = {
    dashboard: "Rating, streak, progress, and what to solve next.",
    problems: "Browse, filter, and open complete statements with math, diagrams, and samples inside the TUI.",
    contests: "Upcoming and live Codeforces contests with countdowns.",
    analytics: "Rating graph, topic breakdown, and activity heatmap.",
    practice: "Skill-model recommendations: weak topics, fresh problems, upsolving, and a goal roadmap.",
  };

  const labels = {
    dashboard: "Dashboard",
    problems: "Problems",
    contests: "Contests",
    analytics: "Analytics",
    practice: "Practice",
  };

  const loaded = new Set();
  const captionEl = document.getElementById("caption");
  const tabs = document.querySelectorAll("#product .tab");
  const panels = document.querySelectorAll("#product .frame .panel");

  function injectScreen(panel) {
    const id = panel.dataset.screen;
    if (!id || loaded.has(id)) return;

    const picture = document.createElement("picture");
    const source = document.createElement("source");
    source.srcset = `img/${id}.webp`;
    source.type = "image/webp";

    const img = document.createElement("img");
    img.src = `img/${id}.png`;
    img.alt = labels[id] || id;
    img.width = 1800;
    img.height = 1166;
    img.decoding = "async";
    if (id === "dashboard") img.fetchPriority = "high";

    picture.append(source, img);
    panel.append(picture);
    panel.classList.remove("loading");
    loaded.add(id);
  }

  function showScreen(id) {
    panels.forEach((p) => {
      const on = p.dataset.screen === id;
      p.classList.toggle("active", on);
      if (on && !loaded.has(id)) {
        p.classList.add("loading");
        injectScreen(p);
      }
    });
  }

  // Load dashboard immediately; prefetch next tab after idle.
  injectScreen(document.getElementById("screen-dashboard"));

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      const id = tab.dataset.screen;
      if (tab.classList.contains("active")) return;

      tabs.forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      showScreen(id);

      if (captionEl) {
        captionEl.classList.add("fade");
        setTimeout(() => {
          captionEl.textContent = captions[id] || "";
          captionEl.classList.remove("fade");
        }, 120);
      }
    });
  });

  if ("requestIdleCallback" in window) {
    requestIdleCallback(() => injectScreen(document.getElementById("screen-problems")));
  }

  // Browser-companion showcase — same tab interaction, static slides (the slide
  // images carry their own labels, so no per-tab caption).
  const cTabs = document.querySelectorAll("#companion .tab");
  const cPanels = document.querySelectorAll("#companion .frame .panel");
  cTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      if (tab.classList.contains("active")) return;
      const id = tab.dataset.cscreen;
      cTabs.forEach((t) => t.classList.toggle("active", t === tab));
      cPanels.forEach((p) => p.classList.toggle("active", p.dataset.cscreen === id));
    });
  });

  const heroSlides = Array.from(document.querySelectorAll(".hero-slide"));
  const heroDots = Array.from(document.querySelectorAll("[data-hero-slide]"));
  const heroTitle = document.getElementById("hero-shot-title");
  let heroIndex = 0;
  let heroTimer = null;

  function showHeroSlide(index) {
    if (!heroSlides.length) return;
    heroIndex = (index + heroSlides.length) % heroSlides.length;
    heroSlides.forEach((slide, i) => {
      const active = i === heroIndex;
      slide.classList.toggle("active", active);
      if (active && heroTitle) heroTitle.textContent = slide.dataset.title || "cpos";
    });
    heroDots.forEach((dot, i) => dot.classList.toggle("active", i === heroIndex));
  }

  function startHeroCarousel() {
    if (heroSlides.length < 2 || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    heroTimer = window.setInterval(() => showHeroSlide(heroIndex + 1), 4200);
  }

  heroDots.forEach((dot) => {
    dot.addEventListener("click", () => {
      if (heroTimer) window.clearInterval(heroTimer);
      showHeroSlide(Number(dot.dataset.heroSlide || 0));
      startHeroCarousel();
    });
  });

  showHeroSlide(0);
  startHeroCarousel();

  const themeToggle = document.querySelector(".theme-toggle");
  const themeMeta = document.querySelector('meta[name="theme-color"]');

  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("cpos-theme", theme);
    } catch {
      // Theme still works for the current page even if persistence is blocked.
    }
    if (themeMeta) themeMeta.setAttribute("content", theme === "light" ? "#f7f9fb" : "#08090b");
    if (themeToggle) {
      themeToggle.setAttribute(
        "aria-label",
        theme === "light" ? "Switch to dark theme" : "Switch to light theme"
      );
    }
  }

  if (themeToggle) {
    setTheme(document.documentElement.dataset.theme || "dark");
    themeToggle.addEventListener("click", () => {
      setTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");
    });
  }

  const liveSources = {
    repo: "https://api.github.com/repos/Soham109/cpos",
    latestRelease: "https://api.github.com/repos/Soham109/cpos/releases/latest",
    vscodeExtensionId: "sohamaggarwal.cpos-vscode",
    redditPost: "https://www.reddit.com/r/codeforces/comments/1tvjxub/i_built_a_better_cph/.json?raw_json=1",
  };

  const liveFallbacks = {
    redditViews: 20000,
    redditUpvotes: 150,
  };

  function setLiveStat(name, value) {
    if (!value) return;
    document.querySelectorAll(`[data-live-stat="${name}"]`).forEach((el) => {
      el.textContent = value;
    });
  }

  function formatCompact(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "";
    if (n >= 1000000) return `${trimDecimal(n / 1000000)}m`;
    if (n >= 1000) return `${trimDecimal(n / 1000)}k`;
    return String(Math.round(n));
  }

  function trimDecimal(value) {
    return value.toFixed(value >= 10 ? 0 : 1).replace(/\.0$/, "");
  }

  function formatInstallCount(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return "";
    if (n >= 10000) return formatCompact(n);
    return n.toLocaleString("en-US");
  }

  async function fetchVscodeInstalls() {
    const res = await fetch("https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json;api-version=3.0-preview.1",
      },
      body: JSON.stringify({
        filters: [{ criteria: [{ filterType: 7, value: liveSources.vscodeExtensionId }] }],
        flags: 914,
      }),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    const stats = data?.results?.[0]?.extensions?.[0]?.statistics || [];
    const install = stats.find((s) => s.statisticName === "install")?.value;
    const downloads = stats.find((s) => s.statisticName === "downloadCount")?.value;
    return Math.round(Math.max(Number(install) || 0, Number(downloads) || 0));
  }

  async function fetchJson(url) {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function loadLiveStats() {
    const fallbackViews = `${formatCompact(liveFallbacks.redditViews)}+`;

    fetchJson(liveSources.latestRelease)
      .then((release) => setLiveStat("release", release.tag_name || release.name))
      .catch(() => {});

    fetchJson(liveSources.repo)
      .then((repo) => {
        const stars = formatCompact(repo.stargazers_count);
        if (stars) setLiveStat("github-stars", stars);
      })
      .catch(() => {});

    fetchVscodeInstalls()
      .then((installs) => {
        const formatted = formatInstallCount(installs);
        if (formatted) setLiveStat("vscode-downloads", formatted);
      })
      .catch(() => {});

    fetchJson(liveSources.redditPost)
      .then((listing) => {
        const post = listing?.[0]?.data?.children?.[0]?.data || {};
        const upvotes = Math.max(Number(post.score) || 0, liveFallbacks.redditUpvotes);
        const views = Math.max(Number(post.view_count) || 0, liveFallbacks.redditViews);
        const formattedViews = `${formatCompact(views)}+`;
        const formatted = `${formatCompact(upvotes)}+ upvotes`;
        setLiveStat("reddit-upvotes", formatted);
        setLiveStat("reddit-summary", `${formattedViews} views · ${formatted}`);
        setLiveStat("reddit-nav", formattedViews);
      })
      .catch(() => {
        setLiveStat("reddit-nav", fallbackViews);
        setLiveStat("reddit-summary", `${fallbackViews} views · ${liveFallbacks.redditUpvotes}+ upvotes`);
      });
  }

  loadLiveStats();

  document.querySelectorAll("[data-copy]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const cmd = btn.dataset.copy;
      try {
        await navigator.clipboard.writeText(cmd);
        const orig = btn.textContent;
        btn.textContent = "Copied";
        setTimeout(() => { btn.textContent = orig; }, 1500);
      } catch {
        window.prompt("Run:", cmd);
      }
    });
  });
})();
