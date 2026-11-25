import type { Config } from "tailwindcss";

/**
 * 设计 token 全部来自 DESIGN-claude.md（Anthropic 风格规范）。
 * 基调：奶油画布 + 珊瑚主色 + 深色面板；衬线标题用开源替代（Cormorant Garamond / Noto Serif SC）。
 */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        primary: "#cc785c",
        "primary-active": "#a9583e",
        "primary-disabled": "#e6dfd8",
        ink: "#141413",
        body: "#3d3d3a",
        "body-strong": "#252523",
        muted: "#6c6a64",
        "muted-soft": "#8e8b82",
        hairline: "#e6dfd8",
        "hairline-soft": "#ebe6df",
        canvas: "#faf9f5",
        "surface-soft": "#f5f0e8",
        "surface-card": "#efe9de",
        "surface-cream-strong": "#e8e0d2",
        "surface-dark": "#181715",
        "surface-dark-elevated": "#252320",
        "surface-dark-soft": "#1f1e1b",
        "on-primary": "#ffffff",
        "on-dark": "#faf9f5",
        "on-dark-soft": "#a09d96",
        "accent-teal": "#5db8a6",
        "accent-amber": "#e8a55a",
        success: "#5db872",
        warning: "#d4a017",
        error: "#c64545",
      },
      borderRadius: {
        xs: "4px",
        sm: "6px",
        md: "8px",
        lg: "12px",
        xl: "16px",
      },
      fontFamily: {
        display: ['"Cormorant Garamond"', '"Noto Serif SC"', "serif"],
        body: ["Inter", '"Noto Sans SC"', "system-ui", "sans-serif"],
        code: ['"JetBrains Mono"', "ui-monospace", "monospace"],
      },
      fontSize: {
        "display-lg": ["48px", { lineHeight: "1.1", letterSpacing: "-1px" }],
        "display-md": ["36px", { lineHeight: "1.15", letterSpacing: "-0.5px" }],
        "display-sm": ["28px", { lineHeight: "1.2", letterSpacing: "-0.3px" }],
        "title-lg": ["22px", { lineHeight: "1.3", fontWeight: "500" }],
        "title-md": ["18px", { lineHeight: "1.4", fontWeight: "500" }],
        "title-sm": ["16px", { lineHeight: "1.4", fontWeight: "500" }],
        "body-md": ["16px", { lineHeight: "1.55" }],
        "body-sm": ["14px", { lineHeight: "1.55" }],
        caption: ["13px", { lineHeight: "1.4", fontWeight: "500" }],
      },
    },
  },
  plugins: [],
} satisfies Config;
