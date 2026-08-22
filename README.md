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
└── poker-n-back/               # 扑克牌双重 N-back 记忆训练网页
    ├── poker-n-back.html           # 页面结构，双击即可打开
    ├── styles.css                  # 专注训练主题、响应式与黑暗模式
    ├── game-core.js                # 发牌、判断、计分与记录逻辑
    ├── app.js                      # 计时、交互与页面状态控制
    └── game-core.test.js           # 核心规则与页面契约测试
```

## Lucky Wheel
一个基于 Tkinter 的桌面幸运转盘，可用于抽奖，金额从 0.01 到 10 不等，概率随金额上升而指数级下降。支持单抽与连抽十次两种模式，并按金额划分蓝、紫、金、红四档奖励。每次抽奖和花销都会自动记录到 prize.txt 并汇总累计金额与剩余余额。

## what to eat
用于解决选择困难症的网页，双击即可在浏览器中打开。以跑马灯方式随机抽选食物，选中后撒花庆祝。支持增删改食物列表，并通过浏览器本地存储自动保存。

## dice roller
模拟掷骰子的网页，基于 Three.js 用真实多面体渲染 D4/D6/D8/D10/D12/D20 各类骰子（默认 D6），双击即可在浏览器中打开。可选面数与数量（默认 1），点击后骰子从空中翻滚落入托盘、回弹定格到掷出的那一面并显示总点数，可拖动旋转视角。每次投掷都会记入历史并通过浏览器本地存储保存；Three.js 库随文件一起分发，无需联网。

## poker double n-back
一个可配置总牌数和 N 值的扑克牌双重 N-back 记忆训练网页，默认使用 10 张牌和 2-back。每张牌展示 4 秒，从第 N+1 张开始判断花色相同、点数相同或都不相同，错误与超时会显示正确答案，结束后给出正确率和逐牌记录。页面可直接双击离线运行，并会跟随系统自动切换浅色或黑暗模式。
