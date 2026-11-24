# Overview
The following are some lightweight tools I made when I was bored.

## 目录结构

```
tools/
├── Lucky Wheel/                # 幸运抽奖转盘（Python + Tkinter）
│   ├── lucky_draw.py               # 主程序：转盘 GUI、概率计算、抽奖记录
│   ├── spend_logger.py             # 花销记录小工具
│   ├── test_lucky_draw.py          # 单元测试
│   ├── wheel.png                   # 转盘图片
│   └── pointer.png                 # 指针图片
├── what-to-eat/                # 「今天吃什么」网页（纯 HTML/CSS/JS）
│   └── what-to-eat.html            # 单文件页面，双击即可打开
├── dice-roller/                # 「掷骰子」网页（HTML + Three.js 3D）
│   ├── dice-roller.html            # 页面结构与样式，双击即可打开
│   ├── app.js                      # 界面交互：面数/数量、历史记录、本地存储
│   ├── dice-3d.js                  # Three.js 3D 骰子引擎：多面体、贴图、投掷动画
│   └── three.min.js                # Three.js 库（随文件分发，离线可用）
├── poker-n-back/               # 扑克牌双重 N-back 记忆训练网页
│   ├── poker-n-back.html           # 页面结构，双击即可打开
│   ├── styles.css                  # 专注训练主题、响应式与黑暗模式
│   ├── game-core.js                # 发牌、判断、计分与记录逻辑
│   ├── app.js                      # 计时、交互与页面状态控制
│   └── game-core.test.js           # 核心规则与页面契约测试
├── reaction-training/          # 反应训练台：见缝插针/打地鼠/数字消除三合一网页
│   ├── index.html                  # 首页，展示三个训练项目入口
│   ├── assets/
│   │   ├── common.js                   # 共享工具：洗牌、计时格式化、本地存储读写、评级
│   │   └── styles.css                  # 共享样式，含浅色/黑暗模式
│   ├── games/
│   │   ├── needle.html                  # 见缝插针页面
│   │   ├── needle.js                    # 见缝插针交互逻辑
│   │   ├── needle-core.js               # 见缝插针核心规则
│   │   ├── whack-a-mole.html            # 打地鼠页面
│   │   ├── whack-a-mole.js              # 打地鼠交互逻辑
│   │   ├── whack-a-mole-core.js         # 打地鼠核心规则
│   │   ├── number-clear.html            # 数字消除页面
│   │   ├── number-clear.js              # 数字消除交互逻辑
│   │   └── number-clear-core.js         # 数字消除核心规则
│   └── tests/                       # 各核心逻辑与页面契约的单元测试
└── quota-float/              # 桌面半透明悬浮框：显示 Antigravity 与 Codex 的 5h/周剩余额度（Python + Tkinter）
    ├── quota_float.pyw             # 主程序：无边框置顶悬浮窗、拖动、右键菜单、定时刷新
    ├── providers.py                # 额度数据源：Codex 在线接口/本地会话日志、Antigravity 本地服务
    └── test_providers.py           # 数据解析单元测试
```

## Lucky Wheel
一个基于 Tkinter 的桌面幸运转盘，可用于抽奖，金额从 0.01 到 10 不等，概率随金额上升而指数级下降。支持单抽与连抽十次两种模式，并按金额划分蓝、紫、金、红四档奖励。每次抽奖和花销都会自动记录到 prize.txt 并汇总累计金额与剩余余额。

## what to eat
用于解决选择困难症的网页，双击即可在浏览器中打开。以跑马灯方式随机抽选食物，选中后撒花庆祝。支持增删改食物列表，并通过浏览器本地存储自动保存。

## dice roller
模拟掷骰子的网页，基于 Three.js 用真实多面体渲染 D4/D6/D8/D10/D12/D20 各类骰子（默认 D6），双击即可在浏览器中打开。可选面数与数量（默认 1），点击后骰子从空中翻滚落入托盘、回弹定格到掷出的那一面并显示总点数，可拖动旋转视角。每次投掷都会记入历史并通过浏览器本地存储保存。

## poker double n-back
一个可配置总牌数和 N 值的扑克牌双重 N-back 记忆训练网页，默认使用 10 张牌和 2-back。每张牌展示 4 秒，从第 N+1 张开始判断花色相同、点数相同或都不相同，错误与超时会显示正确答案，结束后给出正确率和逐牌记录。页面可直接双击离线运行，并会跟随系统自动切换浅色或黑暗模式。

## reaction training
一个反应训练台网页，从首页可进入见缝插针、打地鼠、数字消除三个短时反应训练项目。见缝插针要在旋转圆盘的空隙中点击投针，撞上已有针即结束；打地鼠要快速点击随机出现的目标；数字消除要按从小到大的顺序点完全部数字，三者都会记录成绩并给出对应评级。

## quota float
一个基于 Tkinter 的桌面半透明悬浮框，双击 quota_float.pyw 启动后常驻屏幕右上角，用进度条显示 Antigravity 与 Codex 的 5h 额度和周额度剩余百分比及重置倒计时。Codex 额度优先通过 ~/.codex/auth.json 的登录态在线查询，失败时回退读取本地会话日志中的最新额度；Antigravity 额度从正在运行的 Antigravity 本地语言服务获取，因此需要先启动 Antigravity。悬浮框可左键拖动、双击立即刷新，右键菜单可切换置顶、调整不透明度和开机自启，颜色跟随系统浅色/深色主题。
