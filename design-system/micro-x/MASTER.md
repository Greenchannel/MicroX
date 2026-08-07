# Design System Master File

> **LOGIC:** When building a specific page, first check `design-system/pages/[page-name].md`.
> If that file exists, its rules **override** this Master file.
> If not, strictly follow the rules below.

---

**Project:** MicroX
**Generated:** 2026-08-08
**Category:** Social Media App
**Design Dials:** Density 5/10 (Standard)

---

## Global Rules

### Color Palette（「晨光」浅色主题）

| Role | Hex (Light) | Hex (Dark) | CSS Variable |
|---|---|---|---|
| Primary | `#6C5CE7` | `#8B7CF0` | `--color-primary` |
| On Primary | `#FFFFFF` | `#FFFFFF` | `--color-on-primary` |
| Secondary | `#5443D6` | `#6C5CE7` | `--color-secondary` |
| Accent/CTA | `#6C5CE7` | `#8B7CF0` | `--color-accent` |
| Background | `#F4F6FB` | `#0B0F1A` | `--color-background` |
| Foreground | `#1B2233` | `#EEF2F8` | `--color-foreground` |
| Panel / Card | `#FFFFFF` | `#121A2E` | `--color-panel` |
| Border | `#E2E7F1` | `#24304D` | `--color-border` |
| Destructive | `#E5484D` | `#F06166` | `--color-destructive` |
| Ring | `rgba(108,92,231,.35)` | `rgba(139,124,240,.5)` | `--color-ring` |

**Color Notes:** 暖白浅底 + 靛紫强调，暗色模式自动跟随系统（`prefers-color-scheme`）。

### Typography

- **Heading Font:** Sora（标题/品牌/页面大标题）
- **Body Font:** Manrope（正文/按钮/输入）
- **中文回退:** PingFang SC / Microsoft YaHei / Noto Sans CJK SC
- **Mood:** 清爽、社区、现代、活力、可信
- **Google Fonts:** [Sora + Manrope](https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=Sora:wght@600;700;800&display=swap)

**CSS Import:**
```css
@import url('https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=Sora:wght@600;700;800&display=swap');
```

### Spacing Variables

*Density: 5/10 — Standard*

| Token | Value | Usage |
|-------|-------|-------|
| `--space-xs` | `4px` / `0.25rem` | Tight gaps |
| `--space-sm` | `8px` / `0.5rem` | Icon gaps, inline spacing |
| `--space-md` | `16px` / `1rem` | Standard padding |
| `--space-lg` | `24px` / `1.5rem` | Section padding |
| `--space-xl` | `32px` / `2rem` | Large gaps |
| `--space-2xl` | `48px` / `3rem` | Section margins |
| `--space-3xl` | `64px` / `4rem` | Hero padding |

### Shadow Depths

| Level | Value (Light) | Usage |
|-------|-------|-------|
| `--shadow-sm` | `0 1px 2px rgba(30,41,80,.06)` | Subtle lift |
| `--shadow-md` | `0 8px 24px rgba(30,41,80,.1)` | Cards, buttons |
| `--shadow-lg` | `0 18px 44px rgba(30,41,80,.16)` | Modals, dropdowns |

---

## Component Specs

### Buttons

```css
/* Primary Button: 靛紫渐变 + 柔光阴影 */
.btn-primary {
  background: linear-gradient(135deg, #6C5CE7, #5443D6);
  color: #fff;
  padding: 10px 22px;
  border-radius: 999px;
  font-weight: 600;
  box-shadow: 0 4px 14px rgba(108,92,231,.35);
  transition: all 200ms ease;
  cursor: pointer;
}

.btn-primary:hover {
  transform: translateY(-1px);
  box-shadow: 0 6px 20px rgba(108,92,231,.35);
}

/* Secondary/Ghost Button */
.btn-ghost {
  background: transparent;
  color: #6C5CE7;
  padding: 10px 22px;
  border-radius: 999px;
  font-weight: 600;
  transition: all 200ms ease;
  cursor: pointer;
}

.btn-ghost:hover {
  background: rgba(108,92,231,.12);
}
```

### Cards

```css
.card {
  background: #FFFFFF;
  border: 1px solid rgba(94,110,150,.16);
  border-radius: 18px;
  padding: 16px;
  box-shadow: var(--shadow-sm);
  transition: all 200ms ease;
}

.card:hover {
  box-shadow: var(--shadow-md);
  transform: translateY(-2px);
}
```

### Inputs

```css
.input {
  padding: 11px 13px;
  background: #FFFFFF;
  border: 1px solid #E2E7F1;
  border-radius: 12px;
  font-size: 14px;
  color: #1B2233;
  transition: border-color 200ms ease, box-shadow 200ms ease;
}

.input:focus {
  border-color: #6C5CE7;
  outline: none;
  box-shadow: 0 0 0 3px rgba(108,92,231,.12);
}
```

### Modals

```css
.modal-overlay {
  background: rgba(20,24,40,.55);
  backdrop-filter: blur(4px);
}

.modal {
  background: #FFFFFF;
  border-radius: 20px;
  padding: 22px;
  box-shadow: var(--shadow-lg);
  max-width: 380px;
  width: 100%;
}
```

---

## Style Guidelines

**Style:** 晨光 · 清爽圆润

**Keywords:** 暖白、靛紫、柔和圆角、渐变强调、光晕背景、干净、现代、社区感

**Key Effects:** 渐变品牌标识、卡片悬浮上浮、圆角 12~20px、150~300ms 过渡、柔和光晕背景

### Page Pattern

**Pattern Name:** Community/Forum Landing

- **Conversion Strategy:** Show active community (member count, posts today). Highlight benefits. Preview content. Easy onboarding.
- **CTA Placement:** Join button prominent + After member showcase
- **Section Order:** 1. Hero (community value prop), 2. Popular topics/categories, 3. Active members showcase, 4. Join CTA

---

## Anti-Patterns (Do NOT Use)

- ✗ Heavy skeuomorphism
- ✗ Accessibility ignored

### Additional Forbidden Patterns

- ✗ **Emojis as icons** — Use SVG icons (Heroicons, Lucide, Simple Icons)
- ✗ **Missing cursor:pointer** — All clickable elements must have cursor:pointer
- ✗ **Layout-shifting hovers** — Avoid scale transforms that shift layout
- ✗ **Low contrast text** — Maintain 4.5:1 minimum contrast ratio
- ✗ **Instant state changes** — Always use transitions (150-300ms)
- ✗ **Invisible focus states** — Focus states must be visible for a11y

---

## Pre-Delivery Checklist

Before delivering any UI code, verify:

- [ ] No emojis used as icons (use SVG instead)
- [ ] All icons from consistent icon set (Heroicons/Lucide)
- [ ] `cursor-pointer` on all clickable elements
- [ ] Hover states with smooth transitions (150-300ms)
- [ ] Text contrast 4.5:1 minimum (light & dark mode)
- [ ] Focus states visible for keyboard navigation
- [ ] `prefers-reduced-motion` respected
- [ ] Responsive: 375px, 768px, 1024px, 1440px
- [ ] No content hidden behind fixed navbars
- [ ] No horizontal scroll on mobile
