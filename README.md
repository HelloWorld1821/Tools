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
└── what-to-eat/                # 「今天吃什么」网页（纯 HTML/CSS/JS）
    └── what-to-eat.html            # 单文件页面，双击即可打开
```

## Lucky Wheel
一个基于 Tkinter 的桌面幸运转盘，可用于抽奖，金额从 0.01 到 10 不等，概率随金额上升而指数级下降。支持单抽与连抽十次两种模式，并按金额划分蓝、紫、金、红四档奖励。每次抽奖和花销都会自动记录到 prize.txt 并汇总累计金额与剩余余额。

## what to eat
用于解决选择困难症的网页，双击即可在浏览器中打开。以跑马灯方式随机抽选食物，选中后撒花庆祝。支持增删改食物列表，并通过浏览器本地存储自动保存。
