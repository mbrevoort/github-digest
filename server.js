'use strict'

const express = require('express')
const Slapp = require('slapp')
const ConvoStore = require('slapp-convo-beepboop')
const Context = require('slapp-context-beepboop')
const kv = require('beepboop-persist')( { provider: process.env.PERSIST_PROVIDER || 'beepboop' })
const jsonParser = require('body-parser').json()

// use `PORT` env var on Beep Boop - default to 3000 locally
var port = process.env.PORT || 3000

var slapp = Slapp({
  // Beep Boop sets the SLACK_VERIFY_TOKEN env var
  verify_token: process.env.SLACK_VERIFY_TOKEN,
  convo_store: ConvoStore(),
  context: Context()
})


slapp.message('^link (.*)', ['direct_message', 'direct_mention'], (msg, text, repoFullname) => {
  repoFullname = repoFullname && repoFullname.trim()
  let key = channelKey(msg)

  // channelKey ==> repo
  kv.get(key, (err, list) => {
    if (err) return msg.say(`😱 ${err}`)
    list = list || []
    if (list.indexOf(repoFullname) < 0) {
      list.push(repoFullname)
    }
    kv.set(channelKey(msg), list, (err) => {
      if (err) return msg.say(`😱 ${err}`)
    })
  })

  // repo ==> channelKey
  kv.get(repoFullname, (err, list) => {
    if (err) return msg.say(`😱 ${err}`)
    list = list || []
    if (list.indexOf(key) < 0) {
      list.push(msg.meta)
    }
    kv.set(repoFullname, list, (err) => {
      if (err) return msg.say(`😱 ${err}`)
    })
  })

})

slapp.message('^unlink (.*)', ['direct_message', 'direct_mention'], (msg, text, repoFullname) => {
  repoFullname = repoFullname && repoFullname.trim()
  let key = channelKey(msg)


  // channelKey ==> repo
  kv.get(key, (err, list) => {
    if (err) return msg.say(`😱 ${err}`)
    list = list || []
    let i = list.indexOf(repoFullname)
    if (i < 0) {
      return msg.say(`${repoFullname} not linked`)
    } else if (i === 0) {
      list.pop()
    } else {
      list = list.splice(i, 1)
    }
    kv.set(key, list, (err) => {
      if (err) return msg.say(`😱 ${err}`)
    })
  })

  // repo ==> channelKey
  kv.get(repoFullname, (err, list) => {
    if (err) return msg.say(`😱 ${err}`)
    list = list || []
    let i = list.indexOf(key)
    if (i < 0) {
      return
    } else if (i === 0) {
      list.pop()
    } else {
      list = list.splice(i, 1)
    }
    kv.set(repoFullname, list, (err) => {
      if (err) return msg.say(`😱 ${err}`)
    })
  })

})

slapp.message('^links', ['direct_message', 'direct_mention'], (msg) => {
  kv.get(channelKey(msg), (err, list) => {
    if (err) return msg.say(`😱 ${err}`)
    list = list || []
    msg.say(`${list.length} link${list.length > 1 ? 's' : ''} ${list.map((it) =>  `\`${it}\``).join(',')}`)
  })
})

slapp.use((msg, next) => {
  if (msg.body.event.type === 'message' && !msg.body.event.bot_id ) {

  }
})

function channelKey(msg) {
  return `${msg.meta.team_id}-${msg.meta.channel_id}`
}


// attach Slapp to express server
var server = slapp.attachToExpress(express())

server.post('/webhook', jsonParser, (req, res) => {
  // console.log('GITHUB webhook', req.body)
  let notification = getNotification(req.body)
  if (!notification) {
    return console.log('Ignoring unsupported Github Webhook type')
  }

  sendNotificaiton(req.body.repository.full_name, notification)
  res.send(200)
})

function getNotification(body) {
  if (body.issue && body.comment) {
    return {
      short: `∆ <${body.comment.html_url}|comment> ${body.action} by <https://github.com/${body.issue.user.login}|${body.issue.user.login}> • ${trimComment(body.comment.body, 25)}`,
      long: {
        text: `<${body.comment.html_url}|comment> ${body.action} by <https://github.com/${body.issue.user.login}|${body.issue.user.login}>:\n${body.comment.body}`,
        username: body.repository.full_name,
        icon_url: 'https://assets-cdn.github.com/images/modules/logos_page/GitHub-Mark.png',
        as_user: false,
        markdwn: true
      }
    }
  }
  if (body.issue) {
    return {
      short: `∆ ${body.issue.user.login} ${body.action} issue on ${body.issue.title.substring(0, 25)}`,
      long: {
        text: `${body.issue.user.login} ${body.action} issue on <${body.issue.html_url}|${body.issue.title}>:\n${body.issue.body}`,
        username: body.repository.full_name,
        icon_url: 'https://assets-cdn.github.com/images/modules/logos_page/GitHub-Mark.png',
        as_user: false
      }
    }
  } else {
    null
  }
}

function sendNotificaiton(repo, payload) {
  kv.get(repo, (err, list) => {
    if (err) return console.log('Error geting repo from webhook', err)
    list = list || []
    list.forEach((meta) => {
      getRecentMessages(meta.team_id, meta.channel_id, repo, (err, recentMessage) => {
        if (err) return console.log('Error getRecentMessages', err)
        if (recentMessage && recentMessage.messages.length) {
          console.log('FOUND recentMessage!')
          // update existing message and digest
          recentMessage.messages.push(payload)
          let attachments = []
          recentMessage.messages.forEach((message) => {
            attachments.push({ text: message.short, mrkdwn_in: ['text'] })
          })
          let updatePayload = {
            ts: recentMessage.ts,
            token: meta.bot_token,
            channel: meta.channel_id,
            username: repo,
            icon_url: 'https://assets-cdn.github.com/images/modules/logos_page/GitHub-Mark.png',
            as_user: false,
            text: '',
            mrkdwn: true,
            attachments: attachments
          }
          console.log(updatePayload)
          slapp.client.chat.update(updatePayload, (err, result) => {
            if (err) return console.log(err)
            putMessage(meta.team_id, meta.channel_id, repo, recentMessage)
          })
        } else {
          // send new message
          let copy = Object.assign({ token:  meta.bot_token, channel: meta.channel_id, mrkdwn: true }, payload.long);
          slapp.client.chat.postMessage(copy, (err, result) => {
            if (err) return console.log(err)
            putMessage(meta.team_id, meta.channel_id, repo, {
              ts: result.ts,
              messages: [payload]
            })
          })
        }
      })
    })
  })
}

// {
//   team,
//   channel,
//   ts,
//   messages
// }

//
// Recent Message storage
//
const RECENT_TIMEOUT_MS = 30000
var timeouts = {}

// by channelKey
var messages = {}

function getRecentMessages(team, channel, repo, callback) {
  let key = `${team}~${channel}~${repo}`
  callback(null, messages[key])
}

function putMessage(team, channel, repo, recentMessage) {
  let key = `${team}~${channel}~${repo}`
  if (timeouts[key]) {
    clearTimeout(timeouts[key])
    delete timeouts[key]
  }
  messages[key] = recentMessage
  timeouts[key] = setTimeout(() => {
    delete timeouts[key]
    delete messages[key]
  }, RECENT_TIMEOUT_MS)
}

function trimComment(body, max) {
  body = body.replace(/\n/g, ' ').replace(/\s\s+/g, ' ')
  if (body.length > max) {
    body = body.substring(0, max) + '…'
  }
  return body
}


// start http server
server.listen(port, (err) => {
  if (err) {
    return console.error(err)
  }

  console.log(`Listening on port ${port}`)
})
