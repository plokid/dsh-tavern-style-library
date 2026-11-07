# 风格卡分析框架

九个维度的测量方法、判定阈值和合成规则。所有观察都要**落数**——没有数字的结论等于没有结论。

框架把两套现成的东西并到了一起：

- [perfectly-replicate-writing-skills](https://github.com/zrh091110225/perfectly-replicate-writing-skills)（MIT）的 7+1 维度与「品味原则」：3 次以上才算特征、保留矛盾、禁用清单优先、不猜、不磨平瑕疵。
- [magic-distillation](https://github.com/dama-cyber/magic-distillation) 的 `fiction-distiller` 在小说场景下的补强：五感权重、人物与对白、可自检的铁律，以及 AI 腔词表。
- 合并后是 9 个维度：词汇 / 句法 / 语气 / 篇章 / 修辞 / 情感 / 视角 / 感官 / 对白。

中文小说的阈值和英文散文不一样，下面的表按中文正文校准。样本少（3～5 段）时只当参考，别当判决。

---

## 1. 词汇 (lexical)

**量什么**

- 高频词 Top 20（中文去掉「的、了、是、在」这类虚词再看）
- 指纹词 10～15 个：在这批文字里的密度明显高于一般文本的词（比如武侠里的「鞘」「檐」「锈」，都市里的「烟火气」「空调外机」）
- 固定搭配 2～3 组：反复一起出现的两个词
- 用词质感：单音节动词多还是双音节多；书面语 / 口语 / 方言 / 文白

**看阈值**

| 指标 | 弱信号 | 强信号 |
| --- | --- | --- |
| 指纹词密度 | 一般文本的 2～3 倍 | 5 倍以上 |
| 单音节动词占比 | < 30% | > 50%（笔调偏硬、偏古） |
| 四字词密度 | 每千字 < 3 | 每千字 > 8（笔调偏文、偏滞） |

---

## 2. 句法 (syntactic)

**量什么**

- 平均句长（按句号/问号/感叹号切）；标准差
- 句长分布：< 8 字 / 8～15 / 15～25 / 25～40 / 40 以上各占多少
- 标点指纹：每千字的破折号、省略号、感叹号、问号、引号数量
- 段落长度：平均每段几句；段落长度的起伏（长短交错还是一片均匀）

**看阈值**

| 指标 | 简洁 | 中间 | 铺陈 |
| --- | --- | --- | --- |
| 平均句长（中文） | < 12 字 | 12～25 字 | > 25 字 |
| 破折号（每千字） | < 1 | 1～3 | > 3 |
| 感叹号（每千字） | 0～1 | 2～4 | > 4（很容易显得吵） |
| 平均段长 | < 3 句 | 3～6 句 | > 6 句 |

**句长波动**（标准差 ÷ 平均）比平均值更能说明笔调：> 0.8 是「忽长忽短」，读起来有呼吸；< 0.4 是匀速，容易平。

---

## 3. 语气 (tonal)

**量什么**

- 口语化程度：儿化、语气词（「呢/吧/啊/嘛」）、方言词、网络词
- 冷热：有没有直接表态、有没有替人物感慨
- 断言强弱：爱不爱用「必须/一定/从来」，还是「也许/像是/似乎」
- 是否解释：写完一个动作后，会不会再补一句「他在想什么」

**四种典型轮廓**

| 轮廓 | 特征 |
| --- | --- |
| 冷静旁观 | 低口语化、低断言、不解释、句长短 |
| 说书人 | 高口语化、爱点评、爱用「你看」「且说」 |
| 抒情 | 高波动、多形容词、直接写情绪 |
| 学者 | 低口语化、多限定、句子长而完整 |

---

## 4. 篇章 (discourse)

**量什么**

- 开头方式：场景 / 动作 / 对白 / 议论 / 时间地点交代
- 推进方式：事件推动 / 感官推动 / 对话推动 / 心理推动
- 收尾方式：动作收、景物收、留白收、议论收
- 场景切换手法：空行、时间词、直接跳
- 逻辑流：顺叙 / 倒叙 / 插叙 / 双线

**判断问题**

1. 同一批材料里开头方式是否高度一致？一致就是一种风格。
2. 结尾是「收得住」还是「说完就完了」？
3. 段落长短是被内容推着走，还是被节奏推着走？

---

## 5. 修辞 (rhetoric)

**量什么**

- 比喻密度：每千字几处；取自哪个领域（自然、器物、身体、战争、食物……）
- 排比 / 对偶：偶发还是结构性
- 设问：每篇几次
- 具体与抽象的比例：能摸到的东西 vs. 概念
- 常用对比结构：「不是 X，是 Y」

**看阈值**

| 手法 | 少用 | 常用 |
| --- | --- | --- |
| 比喻（每千字） | < 2 | > 6 |
| 排比 | 偶发 | 成为节奏骨架 |
| 设问 | 0～1 次/篇 | 3 次以上 |

---

## 6. 情感 (emotion)

**量什么**

- 极性分布：正 / 中 / 负各占多少
- 情绪弧线：上升 / 下落 / U 形 / 平稳 / 反复
- 克制度：直接写情绪，还是让动作和景物承担
- 强度副词：很 / 极 / 无比 —— 用得越少，笔调越克制

**一个常见的误判**：把「写了悲伤的事」当成「笔调悲伤」。要看他**怎么处理**悲伤，是铺开写，还是一句带过。

---

## 7. 视角 (perspective)

**量什么**

- 人称：第一 / 第三限知 / 全知；有没有在段内跳
- 聚焦：贴着谁的感受写；有没有越界知道别人心里的事
- 价值词：反复出现、代表立场的词
- 时间取向：过去 / 当下 / 未来

**原型**

| 原型 | 信号 |
| --- | --- |
| 亲历者 | 第一人称多，写自己的感受 |
| 旁观者 | 少人称，多动作和物件 |
| 引导者 | 第二人称、祈使句 |
| 说教者 | 高价值词密度、断言多 |

---

## 8. 感官 (imagery)

**量什么**

- 五感权重：视觉 / 听觉 / 触觉 / 嗅觉 / 味觉各占多少
- 是否通感（「冷得发白」这种跨感官）
- 描写的取景：近景特写多，还是全景多
- 感官细节的密度：每百字几个可感知的细节

**为什么单列**：很多「像不像」的差异不在句法，在有没有具体的冷热、气味、材质。一段只有视觉的文字，读起来会显得薄。

---

## 9. 对白 (dialogue)

**量什么**

- 对白占比：对白行数 ÷ 总段数
- 单句长度：短促（< 10 字）还是成段
- 提示语：「他说」「他冷冷地说」，还是直接省略
- 人物区分：不同人靠用词、句长、口头禅区分，还是全都一个腔
- 对白里有没有潜台词（说 A 指 B）

---

## 合成规则

1. **写作基因必须跨维度。** 至少两个维度共同支撑才算。例：短句（句法）+ 不解释（语气）+ 少人称（视角）→ 「冷眼旁观」基因。
2. **矛盾是发现，不是错误。** 词汇丰富但断言弱，是「博学而犹豫」的具体样子，照写。
3. **频次压倒直觉。** 你觉得破折号很多，但真数是每千字 0.8 次，就按 0.8 写。
4. **数据不足就标不足。** 只有 3 段材料时，某些维度写「样本不足」，不要猜。
5. **禁用清单优先于正面特征。** 先写「从不做什么」，再写「总是做什么」。
6. **AI 腔单独列。** 那是**外部**的入侵物，不属于作者风格，要作为禁令而不是观察。

---

## 参考与许可

本框架的维度划分与「品味原则」改编自 [perfectly-replicate-writing-skills](https://github.com/zrh091110225/perfectly-replicate-writing-skills)，
并参考 [magic-distillation](https://github.com/dama-cyber/magic-distillation) 的 `fiction-distiller` 在小说场景下的补充。原项目以 MIT 许可发布：

```
MIT License

Copyright (c) 2026

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
