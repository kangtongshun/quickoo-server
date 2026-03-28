// 0. 导入 Express
const express = require('express');

const crypto = require('@wecom/crypto');
const xml2js = require('xml2js');
const { promisify } = require('util');

// 1. 调用 express() 得到一个 app
//    类似于 http.createServer()
const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// 创建XML解析器
const parseXml = promisify(xml2js.parseString);
const buildXml = new xml2js.Builder({
    cdata: true,
    headless: false,
    renderOpts: { pretty: false }
});

// 2. 设置请求对应的处理函数
//    当客户端以 GET 方法请求 /api 的时候就会调用第二个参数：请求处理函数
app.get('/api', (req, res) => {

    const TOKEN = process.env.TOKEN;
    const EncodingAESKey = process.env.ENCODING_AES_KEY;

    console.log("url: " + req.url);

    let echostr = req.query.echostr;
    if (echostr != undefined) { //来自企业微信验证接收消息的验证回调url
        console.log("")
        let timestamp = decodeURIComponent(req.query.timestamp);
        let nonce = decodeURIComponent(req.query.nonce);
        let msg_signature = decodeURIComponent(req.query.msg_signature);
        echostr = decodeURIComponent(echostr);
        console.log("msg_signature: " + msg_signature);
        console.log("timestamp: " + timestamp);
        console.log("nonce: " + nonce);
        console.log("echostr: " + echostr);
        console.log("开始验证签名");

        let newSign = crypto.getSignature(TOKEN, timestamp, nonce, echostr);
        console.log("newSign: " + newSign);
        if (newSign == msg_signature) {
            console.log("签名验证通过，正在解密信息");
            let rand_msg = crypto.decrypt(EncodingAESKey, echostr);
            console.log("rand_msg:");
            console.log(rand_msg);
            let message = rand_msg["message"];
            res.send(message);
        }
        else {
            res.json({
                "url": req.url,
                "error": "签名验证不通过，请检查企业微信配置中Token和EncodingAESKey与后台配置是否一致",
            });
        }
    }
    else {
        res.json({
            "url": req.url,
            "error": "请求无参数"
        });
    }
})

// 处理企业微信推送的消息（POST请求）
app.post('/api', async (req, res) => {
    const TOKEN = process.env.TOKEN;
    const EncodingAESKey = process.env.ENCODING_AES_KEY;
    const CORP_ID = process.env.CORP_ID; // 企业微信的CorpID
    
    console.log("=".repeat(50));
    console.log("收到POST消息推送");
    console.log("请求时间:", new Date().toISOString());
    
    // 获取URL参数并进行Urldecode处理
    let timestamp = req.query.timestamp;
    let nonce = req.query.nonce;
    let msg_signature = req.query.msg_signature;
    
    if (timestamp) timestamp = decodeURIComponent(timestamp);
    if (nonce) nonce = decodeURIComponent(nonce);
    if (msg_signature) msg_signature = decodeURIComponent(msg_signature);
    
    console.log("请求参数:");
    console.log(`msg_signature: ${msg_signature}`);
    console.log(`timestamp: ${timestamp}`);
    console.log(`nonce: ${nonce}`);
    
    try {
        // 获取请求体内容
        let xmlData = req.body;
        
        // 如果请求体是字符串，直接使用；如果是对象，需要转换
        if (typeof xmlData === 'object') {
            xmlData = JSON.stringify(xmlData);
        }
        
        console.log("原始XML数据:", xmlData);
        
        // 解析XML，获取加密字段
        const parsedXml = await parseXml(xmlData);
        console.log("解析后的XML:", JSON.stringify(parsedXml, null, 2));
        
        // 获取加密的消息体
        let encrypt = parsedXml.xml.Encrypt;
        if (Array.isArray(encrypt)) {
            encrypt = encrypt[0];
        }
        
        if (!encrypt) {
            console.error("未找到加密消息体");
            return res.status(400).send("Invalid request");
        }
        
        console.log("加密消息:", encrypt);
        
        // 步骤1: 验证签名（使用加密消息体）
        const newSign = crypto.getSignature(TOKEN, timestamp, nonce, encrypt);
        console.log("计算得到的签名:", newSign);
        console.log("接收到的签名:", msg_signature);
        
        if (newSign !== msg_signature) {
            console.error("签名验证失败");
            return res.status(403).send("签名验证失败");
        }
        
        console.log("签名验证通过");
        
        // 步骤2: 解密消息，得到明文消息结构体
        const decryptedMsg = crypto.decrypt(EncodingAESKey, encrypt);
        console.log("解密后的消息:", decryptedMsg);
        
        const messageContent = decryptedMsg.message;
        
        // 验证CorpID（可选，用于安全校验）
        if (CORP_ID && decryptedMsg.corpid !== CORP_ID) {
            console.warn(`CorpID不匹配: 期望 ${CORP_ID}, 实际 ${decryptedMsg.corpid}`);
        }
        
        // 步骤3: 解析明文消息（XML格式）
        const parsedMessage = await parseXml(messageContent);
        console.log("解析后的消息内容:", JSON.stringify(parsedMessage, null, 2));
        
        const msg = parsedMessage.xml;
        
        // 获取消息类型
        let msgType = msg.MsgType;
        if (Array.isArray(msgType)) msgType = msgType[0];
        
        console.log(`消息类型: ${msgType}`);
        
        // 步骤4: 根据消息类型处理业务逻辑
        let replyContent = null;
        
        switch (msgType) {
            case 'text':
                // 处理文本消息
                let content = msg.Content;
                if (Array.isArray(content)) content = content[0];
                console.log(`收到文本消息: ${content}`);
                
                // 示例：回复相同内容
                replyContent = `<xml>
                    <ToUserName><![CDATA[${msg.FromUserName[0]}]]></ToUserName>
                    <FromUserName><![CDATA[${msg.ToUserName[0]}]]></FromUserName>
                    <CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>
                    <MsgType><![CDATA[text]]></MsgType>
                    <Content><![CDATA[收到您的消息: ${content}]]></Content>
                </xml>`;
                break;
                
            case 'image':
                // 处理图片消息
                let picUrl = msg.PicUrl;
                if (Array.isArray(picUrl)) picUrl = picUrl[0];
                console.log(`收到图片消息: ${picUrl}`);
                
                replyContent = `<xml>
                    <ToUserName><![CDATA[${msg.FromUserName[0]}]]></ToUserName>
                    <FromUserName><![CDATA[${msg.ToUserName[0]}]]></FromUserName>
                    <CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>
                    <MsgType><![CDATA[text]]></MsgType>
                    <Content><![CDATA[已收到您的图片]]></Content>
                </xml>`;
                break;
                
            case 'event':
                // 处理事件消息
                let event = msg.Event;
                if (Array.isArray(event)) event = event[0];
                console.log(`收到事件: ${event}`);
                
                if (event === 'subscribe') {
                    // 关注事件
                    replyContent = `<xml>
                        <ToUserName><![CDATA[${msg.FromUserName[0]}]]></ToUserName>
                        <FromUserName><![CDATA[${msg.ToUserName[0]}]]></FromUserName>
                        <CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>
                        <MsgType><![CDATA[text]]></MsgType>
                        <Content><![CDATA[欢迎关注！]]></Content>
                    </xml>`;
                } else if (event === 'unsubscribe') {
                    // 取消关注事件，不需要回复
                    replyContent = null;
                }
                break;
                
            default:
                console.log(`未处理的消息类型: ${msgType}`);
                replyContent = null;
        }
        
        // 步骤5: 如果需要回复，构造加密响应包
        if (replyContent) {
            console.log("准备回复消息");
            
            // 生成新的时间戳和随机数
            const replyTimestamp = Math.floor(Date.now() / 1000).toString();
            const replyNonce = Math.random().toString(36).substring(2, 15);
            
            // 加密回复消息
            const encryptedReply = crypto.encrypt(EncodingAESKey, replyContent, CORP_ID || '');
            
            // 生成新的签名
            const replySignature = crypto.getSignature(
                TOKEN, 
                replyTimestamp, 
                replyNonce, 
                encryptedReply
            );
            
            // 构造被动响应包（XML格式）
            const responseXml = `<xml>
                <Encrypt><![CDATA[${encryptedReply}]]></Encrypt>
                <MsgSignature><![CDATA[${replySignature}]]></MsgSignature>
                <TimeStamp>${replyTimestamp}</TimeStamp>
                <Nonce><![CDATA[${replyNonce}]]></Nonce>
            </xml>`;
            
            console.log("响应XML:", responseXml);
            
            // 返回响应包
            res.set('Content-Type', 'application/xml');
            return res.send(responseXml);
        } else {
            // 不需要回复消息，直接返回200（空串）
            console.log("无需回复消息，返回空响应");
            return res.status(200).send('');
        }
        
    } catch (error) {
        console.error("处理POST请求时发生错误:", error);
        // 发生错误时返回200（空串），避免企业微信重试
        return res.status(200).send('');
    }
});
app.get('/', (req, res) => {
    res.json({
        "url": req.url,
        "message": "部署成功"
    });
})

const PORT = process.env.PORT || 3000;
// 3. 监听端口号，启动 Web 服务
app.listen(PORT, () => console.log(`app listening on port ${PORT}!`));
