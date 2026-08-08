# Design System Master File

> **LOGIC:** When building a specific page, first check `design-system/pages/[page-name].md`.
> If that file exists, its rules **override** this Master file.
> If not, strictly follow the rules below.

---

**Project:** MicroX
**Generated:** 2026-08-08
**Category:** Social Media App
**Design Dials:** Density 5/10 (Standard)
**Design Reference:** [emilkowalski/skills · apple-design](https://github.com/emilkowalski/skills/blob/main/skills/apple-design/SKILL.md)（Apple WWDC 设计规范 → Web 适配）

---

## Global Rules

### Color Palette（iOS 系统色）

| Role | Hex (Light) | Hex (Dark) | CSS Variable |
|---|---|---|---|
| Accent (System Blue) | `#007AFF` | `#0A84FF` | `--color-accent` |
| On Accent | `#FFFFFF` | `#FFFFFF` | `--color-on-accent` |
| Background (System Gray 6) | `#F2F2F7` | `#000000` | `--color-background` |
| Foreground (Label) | `#1C1C1E` | `#FFFFFF` | `--color-foreground` |
| Secondary Label | `#6E6E73` | `#98989F` | `--color-text-dim` |
| Panel / Card | `#FFFFFF` | `#1C1C1E` | `--color-panel` |
| Separator | `rgba(60,60,67,.22)` | `rgba(84,84,88,.6)` | `--color-border` |
| Destructive (System Red) | `#FF3B30` | `#FF453A` | `--color-destructive` |
| Success (System Green) | `#1F8A3C` | `#32D74B` | `--color-green` |
| Ring | `rgba(0,122,255,.35)` | `rgba(10,132,255,.45)` | `--color-ring` |

**Color Notes:** 使用 iOS 系统色板；明暗双主题自动跟随系统（`prefers-color-scheme`）。深色背景用真黑 `#000`，浮层用深灰材质。

### Typography

- **Font Stack:** 系统字体优先 —— `-apple-system, "SF Pro Text", "Segoe UI", Roboto, "PingFang SC", "Microsoft YaHei", sans-serif`
- **Large Title:** 26px+ / 700 / `letter-spacing: -0.02em` / `line-height: 1.2`
- **Body:** 15px / `line-height: 1.5` / 字距接近 `0`
- **Hierarchy:** 用字重 + 尺寸 + 行高组合构建层级，而非仅靠尺寸
- **No external webfont:** 避免字体加载延迟，尊重系统光学尺寸与字距表

### Spacing Variables

*Density: 5/10 — Standard*

| Token | Value | Usage |
|-------|-------|-------|
| `--space-xs` | `4px` | Tight gaps |
| `--space-sm` | `8px` | Icon gaps, inline spacing |
| `--space-md` | `16px` | Standard padding |
| `--space-lg` | `24px` | Section padding |
| `--space-xl` | `32px` | Large gaps |

### Shadow Depths

| Level | Value (Light) | Usage |
|-------|-------|-------|
| `--shadow-sm` | `0 1px 2px rgba(0,0,0,.06)` | Cards, subtle lift |
| `--shadow-md` | `0 4px 14px rgba(0,0,0,.1)` | Hover cards |
| `--shadow-lg` | `0 12px 32px rgba(0,0,0,.18)` | Modals, menus |

---

## Component Specs

### Materials（毛玻璃材质）

```css
/* 浮动层: 半透明 + 模糊 + 高饱和, 内容在下方滚动 */
.toolbar,
.page-title,
.mobile-header,
.bottom-nav {
  background: color-mix(in srgb, var(--bg) 76%, transparent);
  backdrop-filter: blur(20px) saturate(180%);
  border-bottom: 1px solid var(--border-soft);
}

/* 弹窗/菜单: 更厚重的材质 */
.modal, .tip-menu {
  background: var(--elevated);
  backdrop-filter: blur(24px) saturate(180%);
  box-shadow: var(--shadow-lg);
}
```

### Buttons

```css
/* Primary Button: iOS 系统蓝, 按下即时反馈 */
.btn-primary {
  background: #007AFF;
  color: #fff;
  padding: 10px 20px;
  border-radius: 999px;
  font-weight: 600;
  transition: background 200ms ease, transform 100ms ease-out;
  cursor: pointer;
}

.btn-primary:active { transform: scale(0.97); }  /* 指针按下即响应 */
.btn-primary:hover { background: #3395FF; }
```

### Cards

```css
.card {
  background: #FFFFFF;
  border: 1px solid rgba(60,60,67,.12);
  border-radius: 16px;
  padding: 15px;
  box-shadow: 0 1px 2px rgba(0,0,0,.06);
  transition: all 200ms ease;
}
```

### Inputs（iOS 灰色填充输入框）

```css
.input {
  background: #ECECF1;
  border: 1px solid transparent;
  border-radius: 10px;
  padding: 11px 13px;
  font-size: 15px;
  color: #1C1C1E;
  transition: border-color 200ms ease, box-shadow 200ms ease;
}

.input:focus {
  border-color: #007AFF;
  background: #FFF;
  box-shadow: 0 0 0 3px rgba(0,122,255,.12);
}
```

### Segmented Control（分段控件）

```css
.segmented {
  display: flex;
  padding: 3px;
  background: #ECECF1;
  border-radius: 10px;
}
.segmented .segment.active {
  background: #FFF;
  box-shadow: 0 1px 2px rgba(0,0,0,.06);
  font-weight: 600;
}
```

---

## Style Guidelines

**Style:** Apple 原生感 · 材质与克制

**Keywords:** 毛玻璃、系统蓝、真黑深色、大标题、圆角、克制动效、即时反馈、内容优先

**Key Effects:** 半透明浮层（blur+saturate）、大标题负字距、分段控件、按下微缩反馈、明暗自动切换

### Page Pattern

**Pattern Name:** Community/Forum Landing

- **Conversion Strategy:** Show active community (member count, posts today). Highlight benefits. Preview content. Easy onboarding.
- **CTA Placement:** Join button prominent + After member showcase

---

## Motion & Feedback（源自 apple-design skill）

- **响应性:** 指针按下即反馈（`:active` 缩放/高亮），不要在抬起后才反馈
- **克制动效:** 只用 `transform` / `opacity` 动画；过渡 150~300ms；无弹跳过场
- **空间一致:** 元素从哪个方向出现就从哪个方向消失；菜单/弹层锚定触发源
- **减少动效:** 尊重 `prefers-reduced-motion`（关闭滑动/缩放）、`prefers-reduced-transparency`（毛玻璃降级为实底）、`prefers-contrast`（加强描边）

---

## Anti-Patterns (Do NOT Use)

- ✗ 重拟物、过度装饰
- ✗ 忽略无障碍（对比度 < 4.5:1、无可见焦点）
- ✗ Emoji 当图标（统一使用 SVG）
- ✗ 点击元素缺 `cursor:pointer`
- ✗ 无过渡的瞬间状态变化
- ✗ 在深色模式使用纯白背景

---

## Pre-Delivery Checklist

- [ ] 明暗双主题均通过 4.5:1 对比度
- [ ] `prefers-reduced-motion` / `prefers-reduced-transparency` / `prefers-contrast` 已适配
- [ ] 所有可点击元素有 `cursor:pointer`
- [ ] 焦点状态可见
- [ ] 响应式: 375px / 768px / 1024px / 1440px
- [ ] 毛玻璃浮层不遮挡内容、无横向滚动
