# Design System Master File

> **LOGIC:** When building a specific page, first check `design-system/pages/[page-name].md`.
> If that file exists, its rules **override** this Master file.
> If not, strictly follow the rules below.

---

**Project:** MicroX
**Version:** 2.0
**Generated:** 2026-08-08
**Category:** Social Media App (类 X 微型社交平台)
**Design Dials:** Density 6/10 (Standard-Spacious)
**Design Name:** Aurora（极光）— 主流社交平台融合风格
**References:** X / Threads 的信息流布局 · Linear / Vercel 的精致细节 · iOS / Material 的动效与无障碍

---

## 1. 设计原则

1. **内容优先**：信息流采用无边框列表行（X / Threads 式），卡片只用于商店、个人资料等"收藏品"场景。
2. **克制用色**：主色靛蓝→紫罗兰渐变只用于主行动按钮与关键状态；其余界面保持中性色。
3. **即时反馈**：任何可点击元素在按下瞬间给出反馈（缩放 / 高亮），过渡 150~300ms，只用 `transform` / `opacity` 动效。
4. **明暗双生**：浅色暖中性 + 深色蓝黑，跟随 `prefers-color-scheme`，两套主题对比度均 ≥ 4.5:1。
5. **无障碍优先**：`prefers-reduced-motion` / `prefers-reduced-transparency` / `prefers-contrast` 必须适配，焦点环可见，点击目标 ≥ 40px。

---

## 2. 色彩令牌

| Role | Light | Dark | CSS Variable |
|---|---|---|---|
| Accent (Indigo) | `#6366F1` | `#818CF8` | `--accent` |
| Accent Hover | `#4F46E5` | `#A5B4FC` | `--accent-hover` |
| Accent Deep | `#4338CA` | `#6366F1` | `--accent-deep` |
| Accent Soft | `rgba(99,102,241,.10)` | `rgba(129,140,248,.16)` | `--accent-soft` |
| Accent Ring | `rgba(99,102,241,.32)` | `rgba(129,140,248,.45)` | `--accent-ring` |
| Accent Gradient | `135deg #6366F1 → #8B5CF6` | 同左 | `--accent-grad` |
| Background | `#F6F7F9` | `#0B0E14` | `--bg` |
| Panel | `#FFFFFF` | `#141821` | `--panel` |
| Elevated | `rgba(255,255,255,.82)` | `rgba(27,33,48,.82)` | `--elevated` |
| Foreground | `#0F1419` | `#E7E9EA` | `--text` |
| Secondary | `#536471` | `#8B98A5` | `--text-dim` |
| Muted | `#8B98A5` | `#5C6B7A` | `--text-mute` |
| Border | `rgba(15,20,25,.10)` | `rgba(231,233,234,.12)` | `--border` |
| Border Soft | `rgba(15,20,25,.06)` | `rgba(231,233,234,.07)` | `--border-soft` |
| Destructive | `#EF4444` | `#F87171` | `--danger` |
| Success | `#059669` | `#34D399` | `--green` |
| Gold | `#F59E0B` | `#FBBF24` | `--gold` |
| Like Pink | `#EC4899` | `#F472B6` | `--like-pink` |

**注意事项**
- 深色背景用蓝黑 `#0B0E14` 而非纯黑，浮层用 `#141821`，避免死黑与刺眼边框。
- 分割线用 1px 发丝边框，层级靠背景明度而非粗线。
- 股市涨跌沿用 A 股习惯：红涨（`#EF4444`）绿跌（`#10B981`）。

---

## 3. 字体

```css
--font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", Roboto,
        "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif;
```

- **不加载外部字体**：系统字体栈保证零加载延迟与中文渲染质量。
- 大标题：`22~26px / 700 / letter-spacing:-0.02em / line-height:1.25`
- 正文：`15px / line-height:1.6`
- 辅助文字：`13px / var(--text-dim)`
- 数字（CCB / 价格）：使用 `font-variant-numeric: tabular-nums` 保证对齐。

---

## 4. 间距 / 圆角 / 阴影

| Token | Value | 用途 |
|---|---|---|
| `--space-xs` | 4px | 图标间、标签内边距 |
| `--space-sm` | 8px | 行内元素间距 |
| `--space-md` | 16px | 标准内边距 |
| `--space-lg` | 24px | 区块内边距 |
| `--space-xl` | 32px | 页面级留白 |

| Radius | Value | 用途 |
|---|---|---|
| `--radius` | 16px | 卡片 / 模态 |
| `--radius-sm` | 10px | 输入框 / 标签 |
| `--radius-pill` | 999px | 按钮 / 徽章 |

| Shadow | Value | 用途 |
|---|---|---|
| `--shadow-sm` | `0 1px 2px rgba(15,20,25,.05)` | 卡片悬浮底 |
| `--shadow-md` | `0 4px 16px rgba(15,20,25,.08)` | hover 提升 |
| `--shadow-lg` | `0 16px 40px rgba(15,20,25,.16)` | 模态 / 菜单 |

---

## 5. 组件规范

### 按钮
```css
.btn-primary {
  background: var(--accent-grad);
  color: #fff;
  border-radius: var(--radius-pill);
  padding: 10px 22px;
  font-weight: 600;
  box-shadow: 0 4px 14px rgba(99,102,241,.28);
  transition: transform 120ms ease, box-shadow 200ms ease, filter 200ms ease;
}
.btn-primary:hover { filter: brightness(1.06); box-shadow: 0 6px 20px rgba(99,102,241,.34); }
.btn-primary:active { transform: scale(.96); }
```
- 次级按钮 `.btn-ghost`：透明底 + 1px 边框 + 文字色；按下 `scale(.97)`。
- 金色按钮 `.btn-gold`：琥珀色渐变，用于交易 / 打赏 / 订阅类操作。
- 危险按钮 `.btn-danger`：红底白字；删除类操作统一使用。
- 所有按钮 `cursor:pointer`，禁用态降低不透明度并禁用指针。

### 输入框
```css
input, textarea, select {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 10px 14px;
  color: var(--text);
  transition: border-color 200ms ease, box-shadow 200ms ease;
}
input:focus, textarea:focus, select:focus {
  outline: none;
  border-color: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-ring);
}
```

### 信息流行（Post）
- 无边框列表行：`padding:16px 20px`，悬停 `background: color-mix(in srgb, var(--text) 3%, transparent)`。
- 左侧头像 44px 圆；正文区：作者行（用户名 + 徽章 + 时间 + 操作）、内容、图片、操作条。
- 操作条：点赞（pink 点亮态 + 计数）、评论、打赏（金色）；图标 18px + 计数 13px。
- 点赞点亮：填充粉色 + `transform:scale(.8)→1` 弹跳动效。
- 评论区分区展开：顶层评论 + 缩进回复树 + 底部评论输入条。

### 导航
- 桌面左侧固定导航：240px，图标 + 文字；激活项为 accent 文字 + 圆形浅色底。
- 手机顶部：毛玻璃吸顶（`backdrop-filter: blur(20px) saturate(180%)`）+ 底部 Tab 栏（同样毛玻璃）。
- 未读徽章：accent 红色小圆点胶囊，右上角定位。

### 弹窗 / 菜单 / Toast
- `modal-mask`：全屏半透明遮罩 + `backdrop-filter: blur(8px)`，点击遮罩关闭。
- `modal`：居中白卡，`transform: translateY(8px) scale(.98) → none` 入场动画。
- `tip-menu`：锚定按钮下方的迷你菜单，圆角 12px + 阴影。
- `toast`：顶部居中胶囊浮条，`translateY(-16px) → 0` 入场，错误态红色。

### 加载与空状态
- `.loading`：居中微旋转 spinner + 文字。
- 骨架屏：`linear-gradient(90deg, ...)` 扫光动画，用于列表初始加载（如可实现）。
- `.empty`：居中 48px 柔和图标 + 13px 次要文字。

---

## 6. 页面模式

### 社区信息流（首页 / 搜索 / 用户主页）
- 三栏：左导航（固定）/ 中间内容（max-width 640px，右侧发丝分隔线）/ 右侧情境栏（搜索 + 新用户 + 公告 + 关于）。
- 平板（700~1100px）：右栏隐藏，左导航收窄为图标。
- 手机（<700px）：单栏，顶栏 + 底部 Tab；发帖框常驻信息流顶部。

### 私信
- 桌面：左侧会话列表（固定 300px）+ 右侧聊天窗；聊天窗高度占满可视区，消息自动滚底。
- 手机：单栏布局，打开会话时聊天窗盖住列表（`hidden-mobile` 控制）。
- 气泡：自己 = 右侧 indigo 渐变浅底；对方 = 左侧中性面板；`max-width: 72%`，圆角 16px 带小尾巴效果。

### 商店 / 股市
- 商品卡片网格：`repeat(auto-fill, minmax(240px, 1fr))`；卡片含预览区、名称、标签、价格、操作按钮。
- 库存与售卖列表：紧凑行式（缩略图 + 名称 + 子信息 + 操作）。

### 管理后台
- 顶部 Tab 胶囊条（横向可滚动）；内容区用"行卡片"（`.admin-report-row` / `.admin-user-row`）呈现。
- 所有行内按钮小号（12px + padding 6px 12px），保持行高紧凑。

### 登录 / 注册
- 居中卡片，背景为浅色渐变光晕（深色模式为蓝黑）。
- 品牌 Logo 大字号 + 大标题；表单输入纵向排列；底部切换"登录/注册"链接。

---

## 7. Motion 规范

- 时长：微交互 120~150ms；组件出现 200~250ms；模态 250ms。
- 缓动：`cubic-bezier(.2,.8,.2,1)`（ease-out 系）。
- 只动画 `transform` / `opacity` / `filter` / `box-shadow`，禁止动画 `width/height/top/left`。
- 方向一致性：从哪儿出现就从哪儿消失（菜单锚定触发点、弹窗居中缩放）。
- `prefers-reduced-motion: reduce` 时关闭所有动画与过渡，仅保留透明度切换。

---

## 8. 无障碍

- 正文 / 次要文字对比度 ≥ 4.5:1（浅色 `#536471` on `#F6F7F9` 达标；深色同理）。
- `:focus-visible` 显示 3px accent 焦点环；键盘可达所有交互。
- 所有图标按钮带 `title`，纯图标操作有 `aria-label`（若缺失由 title 兜底）。
- 触控目标 ≥ 40×40px（手机底部 Tab、操作按钮）。
- `prefers-reduced-transparency` 时毛玻璃降级为纯色背景。
- `prefers-contrast: more` 时加深边框（`--border` 提亮）。

---

## 9. Anti-Patterns（Do NOT Use）

- ✗ 拟物、过度霓虹、渐变滥用（渐变只用于主按钮 / Logo / 登录背景）
- ✗ 忽略无障碍（对比度 < 4.5:1、无焦点环、点击区域过小）
- ✗ Emoji 当图标（统一 SVG；仅支付卡片 / 空状态可用少量 emoji 作插画）
- ✗ 可点击元素缺 `cursor:pointer`
- ✗ 无过渡的瞬变状态
- ✗ 深色模式使用纯白卡片
- ✗ 在信息流中给每条帖子加卡片边框（列表行才是主流社交范式）

---

## 10. Pre-Delivery Checklist

- [ ] 明暗双主题均通过 4.5:1 对比度
- [ ] `prefers-reduced-motion` / `prefers-reduced-transparency` / `prefers-contrast` 已适配
- [ ] 所有可点击元素有 `cursor:pointer`
- [ ] 焦点状态可见
- [ ] 响应式 375px / 768px / 1024px / 1440px 无横向滚动
- [ ] 毛玻璃浮层不遮挡内容
- [ ] 帖子 / 评论 / 私信 / 商店 / 管理 / 登录逐页截图回归通过
