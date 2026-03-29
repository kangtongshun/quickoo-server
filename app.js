require('dotenv').config();
// 0. 导入 Express
const express = require('express');
var WXBizMsgCrypt = require('wechat-crypto');

const crypto = require('@wecom/crypto');
const xml2js = require('xml2js');
const { promisify } = require('util');

// 1. 调用 express() 得到一个 app
//    类似于 http.createServer()
const app = express();

/** 各客服账号 sync_msg 的增量游标（生产环境建议入库） */
const kfCursorByOpenKfid = new Map();
let accessTokenCache = { token: null, expiresAt: 0 };

async function getAccessToken() {
  const now = Date.now();
  if (accessTokenCache.token && now < accessTokenCache.expiresAt - 60_000) {
    return accessTokenCache.token;
  }
  const corpId = process.env.CORP_ID;
  const corpSecret = process.env.CORP_SECRET;
  if (!corpId || !corpSecret) {
    throw new Error('缺少环境变量 CORP_ID 或 CORP_SECRET（用于 gettoken）');
  }
  const url =
    'https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=' +
    encodeURIComponent(corpId) +
    '&corpsecret=' +
    encodeURIComponent(corpSecret);
  const res = await fetch(url);
  const data = await res.json();
  if (data.errcode !== 0) {
    throw new Error(`gettoken 失败: ${data.errcode} ${data.errmsg}`);
  }
  const expiresIn = data.expires_in || 7200;
  accessTokenCache = {
    token: data.access_token,
    expiresAt: now + expiresIn * 1000
  };
  return accessTokenCache.token;
}

/**
 * 收到 kf_msg_or_event 回调后，用回调里的 Token + OpenKfId 拉取具体消息（含 has_more 分页）。
 * @see https://developer.work.weixin.qq.com/document/path/94670
 */
async function syncKfMessagesFromCallback({ token, openKfid }) {
  const accessToken = await getAccessToken();
  let cursor = kfCursorByOpenKfid.get(openKfid) || '';
  const collected = [];
  while (true) {
    const res = await fetch(
      'https://qyapi.weixin.qq.com/cgi-bin/kf/sync_msg?access_token=' +
        encodeURIComponent(accessToken),
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cursor,
          token,
          limit: 1000,
          voice_format: 0,
          open_kfid: openKfid
        })
      }
    );
    const data = await res.json();
    if (data.errcode !== 0) {
      throw new Error(`sync_msg 失败: ${data.errcode} ${data.errmsg}`);
    }
    if (data.msg_list && data.msg_list.length) {
      collected.push(...data.msg_list);
    }
    if (data.next_cursor != null && data.next_cursor !== '') {
      kfCursorByOpenKfid.set(openKfid, data.next_cursor);
      cursor = data.next_cursor;
    }
    if (!data.has_more) break;
  }
  return collected;
}

// 创建XML解析器
const parseXml = promisify(xml2js.parseString);
const buildXml = new xml2js.Builder({
    cdata: true,
    headless: false,
    renderOpts: { pretty: false }
});
/*
 * 接收数据块
 */
function load(stream, callback) {
  var buffers = [];
  stream.on('data', function (trunk) {
    buffers.push(trunk)
  });
  stream.on('end', function () {
    console.log('结束')
    callback(null, Buffer.concat(buffers));
  });
  stream.once('error', callback);
}
/*!
 * 将xml2js解析出来的对象转换成直接可访问的对象
 */
function formatMessage(result) {
  let message = {};
  if (typeof result === 'object') {
    for (var key in result) {
      if (!Array.isArray(result[key]) || result[key].length === 0) {
        continue;
      }
      if (result[key].length === 1) {
        let val = result[key][0];
        if (typeof val === 'object') {
          message[key] = formatMessage(val);
        } else {
          message[key] = (val || '').trim();
        }
      } else {
        message[key] = [];
        result[key].forEach(function (item) {
          message[key].push(formatMessage(item));
        });
      }
    }
  }
  return message;
}

/*!
 * 将回复消息封装成xml格式，其他类型，请按照业务需求重写该函数，或重新构造一个函数来进行业务支持
 */
function reply(fromUsername, toUsername) {
  var info = {};
  info.msgType = 'text';
  info.createTime = new Date().getTime();
  info.toUsername = toUsername;
  info.fromUsername = fromUsername;
  var body = '<xml>' +
    '<ToUserName><![CDATA[' + info.fromUsername + ']]></ToUserName>' +
    '<FromUserName><![CDATA[' + info.toUsername + ']]></FromUserName>' +
    '<CreateTime>' + info.createTime + '</CreateTime>' +
    '<MsgType><![CDATA[text]]></MsgType>' +
    '<Content><![CDATA[你好，同学！]]></Content>' +
    '</xml>';
  return body;
}
/*
 * 回复消息 将消息打包成xml并加密返回给用户
 * */
function send(fromUsername, toUsername) {
    const TOKEN = process.env.TOKEN;
    const EncodingAESKey = process.env.ENCODING_AES_KEY;
    const CORP_ID = process.env.CORP_ID; // 企业微信的CorpID
  var xml = reply(fromUsername, toUsername);
  var cryptor = new WXBizMsgCrypt(TOKEN, EncodingAESKey, CORP_ID);
  var encrypt = cryptor.encrypt(xml);
  var nonce = parseInt((Math.random() * 100000000000), 10);
  var timestamp = new Date().getTime();
  var signature = cryptor.getSignature(timestamp, nonce, encrypt);
  var wrapTpl = '<xml>' +
    '<Encrypt><![CDATA[' + encrypt + ']]></Encrypt>' +
    ' <MsgSignature><![CDATA[' + signature + ']]></MsgSignature>' +
    '<TimeStamp>' + timestamp + '</TimeStamp>' +
    '<Nonce><![CDATA[' + nonce + ']]></Nonce>' +
    '</xml>';
  return wrapTpl;
}
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
    var cryptor = new WXBizMsgCrypt(TOKEN, EncodingAESKey, CORP_ID);

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
    console.log(`nonce--: ${nonce}`);
    load(req, function (err, buff) {
      try {
        if (err) {
          var loadErr = new Error('weChat load message error');
          loadErr.name = 'weChat';
          console.log("loadErr: " + loadErr);
        }
        var xml = buff.toString('utf-8');
        if (!xml) {
          var emptyErr = new Error('-40002_body is empty');
          emptyErr.name = 'weChat';
          console.log("emptyErr: " + emptyErr);
        }
        xml2js.parseString(xml, {
          trim: true
        }, function (err, result) {
          if (err) {
            var parseErr = new Error('-40008_parse xml error');
            parseErr.name = 'weChat';
            console.log("parseErr: " + parseErr);
          }
          console.log("result: " + result);
          var xml = formatMessage(result.xml);
          console.log(xml);
          var encryptMessage = xml.Encrypt;
          // if (msg_signature != cryptor.getSignature(sVerifyTimeStamp, sVerifyNonce, encryptMessage)) {
          //   console.log("fail");
          //   return;
          // }
          console.log("encryptMessage: ",  crypto.decrypt(EncodingAESKey, encryptMessage));
          var decrypted = cryptor.decrypt(encryptMessage);
          var messageWrapXml = decrypted.message;
          if (messageWrapXml === '') {
            console.log("Invalid corpId");
            res.status(401).end('-40005_Invalid corpId');
            return;
          }
          console.log("messageWrapXml: " + messageWrapXml);
          xml2js.parseString(messageWrapXml, {
            trim: true
          }, async function (err, result) {
            if (err) {
              var parseErr = new Error('-40008_BadMessage:' + err.name);
              console.log("parseErr: " + parseErr);
              parseErr.name = 'weChat';
            }
            var message = formatMessage(result.xml);
            console.log("message: " + message);
            var msgType = message.MsgType;
            console.log("msgType: " + msgType);
            var fromUsername = message.ToUserName;
            console.log("fromUsername: " + fromUsername);
            var toUsername = message.FromUserName;
            console.log("toUsername: " + toUsername);
            console.log(message);
            try {
              switch (msgType) {
                case 'text':
                  var sendContent = send(fromUsername, toUsername);
                  console.log("sendContent: " + sendContent);
                  res.status(200).end(sendContent);
                  break;
                  //其他逻辑根据业务需求进行处理
                case 'image':
                case 'video':
                case 'voice':
                case 'location':
                case 'link':
                  res.status(200).send('success');
                  break;
                case 'event':
                  if (message.Event === 'kf_msg_or_event') {
                    const token = message.Token;
                    const openKfid = message.OpenKfId;
                    if (!token || !openKfid) {
                      console.error('kf_msg_or_event 缺少 Token 或 OpenKfId', message);
                    } else {
                      const msgList = await syncKfMessagesFromCallback({
                        token,
                        openKfid
                      });
                      console.log(
                        'sync_msg 拉取条数:',
                        msgList.length,
                        JSON.stringify(msgList, null, 2)
                      );
                      // 在此根据 msg_list 中每条 msgtype（text/image/...）做业务处理
                    }
                    res.status(200).send('success');
                    break;
                  }
                  console.log(message.Event);
                  res.status(200).send('success');
                  break;
                default:
                  res.status(200).send('success');
              }
            } catch (e) {
              console.error('处理消息时出错:', e);
              if (!res.headersSent) {
                res.status(200).send('success');
              }
            }

          });
        });


      } catch (err) {
        console.log("err: " + err);
        res.status(401).end('System Busy');
        return;
      }
    })
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
