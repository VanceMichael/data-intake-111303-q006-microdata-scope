# 来源与接收约定

input.pages 是来源路径。itemprop 在 meta 取 content、a/link 取 href、time 取 datetime，其他元素取文本；相对 URL 按页面基址解析。嵌套 itemscope 是实体关系而非父对象文本。entities 中 properties 各值均为数组，URL 输出本站绝对路径；匿名实体计 anonymousCount，跨页误连计 crossPageEdges。额外保留证据和关系字段。

## 边界与操作

来源地址由启动函数动态分配，不固定端口。所有时间值只按各自字段的业务含义使用；不以请求抵达顺序推导资料版本。可见结果应附真实原始响应、页面或运行证据，不能仅根据调用参数生成结果。

来源演练用例位于 fixtures/cases.json，name 为当前情形名称，routes 为实际供方响应。工作流只通过 source 暴露的接口或页面访问来源；不得导入模拟源内部状态、读取它的文件来代替真实采集。浏览器门户内部动作接口只服务页面，不是机器人可直接调用的业务 API。

读取失败不等于不存在；部分资料可以保留，但需要完整性承诺的结果不能伪称完成。重启时只能复用已落盘且能追溯依据的进度。输出可扩展更多证据字段，但不能省略下列业务状态。

## 业务输入与结果

### 引用与嵌套实体分开

业务输入：
```json
{
  "pages": [
    "/page"
  ]
}
```
结果必须包含：
```json
{
  "entities": [
    {
      "id": "urn:ins:1",
      "properties": {
        "name": [
          "湖站探头"
        ],
        "location": [
          "乙地"
        ],
        "manual": [
          "/manual"
        ],
        "tag": [
          "水质"
        ],
        "category": [
          "水质"
        ]
      }
    }
  ]
}
```

### 同名节点不跨页面串联

业务输入：
```json
{
  "pages": [
    "/one",
    "/two"
  ]
}
```
结果必须包含：
```json
{
  "anonymousCount": 2,
  "crossPageEdges": 0
}
```

### 重复引用只访问一次不丢多值

业务输入：
```json
{
  "pages": [
    "/page"
  ]
}
```
结果必须包含：
```json
{
  "entities": [
    {
      "id": "urn:i",
      "properties": {
        "tag": [
          "甲",
          "乙"
        ]
      }
    }
  ]
}
```
