# 图标来源与映射

以下 25 个 SVG 从用户提供的 `D:/ply-motion/svg-extracted/svg/` 原样复制。应用只读取本目录，不读取提取目录；未使用的 SVG 没有复制。原文件名便于核对，`web/lib/glyphs.ts` 负责语义映射。

| 用途 | 文件 |
| --- | --- |
| Brilliant / Great / Best | 013-Brilliant / 027-great_find / 010-best |
| Excellent / Good / Forced | 023-excellent / 029-good / 028-forced |
| Book / Inaccuracy / Mistake | 012-book / 030-inaccuracy / 034-mistake |
| Miss（红色叉号） / Blunder | 064-_jt / 011-blunder |
| 获胜（白 / 黑） | 046-winner-white / 045-winner |
| 落败（白 / 黑） | 020-defeat_white / 019-defeat_black |
| 将死（白 / 黑） | 015-checkmate_white / 014-checkmate_black |
| 和棋（白 / 黑） | 022-draw_white / 021-draw_black |
| 超时（白 / 黑） | 042-Mxe / 041-Axe |
| 认输、弃局（白 / 黑） | 036-resign_white / 035-resign_black |
| 重复局面 | 044-Ixe |
| 分析器确认挂子 / 礼物 | 025-free_piece |

文件名均以 `.svg` 结尾。当前终局仅使用获胜、落败、和棋图标；表中的将死、超时、认输、重复局面图标作为历史素材保留，软件不再使用它们区分终局原因。

图像自带底色和阴影，使用完整图像，不额外叠加徽章底色。所有棋盘图标继续共用 `.badge` 的右上角位置和尺寸。

素材为用户提供的提取文件，原始权利人和授权未在目录中明确标注；本项目 Apache-2.0 声明不重新授权这些素材，见根目录 `THIRD_PARTY.md`。
