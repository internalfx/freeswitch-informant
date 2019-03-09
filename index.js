
module.exports = function (config) {
  let Promise = require('bluebird')
  let esl = require('modesl')
  let _ = require('lodash')
  let retry = require('promise-retry')
  let moment = require('moment')
  let xmlParser = require('xml2js').Parser({
    explicitRoot: false,
    explicitArray: false,
    mergeAttrs: true
  })
  let libPhone = require('google-libphonenumber')
  let PNF = libPhone.PhoneNumberFormat
  let phoneUtil = libPhone.PhoneNumberUtil.getInstance()

  let del = require('del')
  let fs = require('fs')
  let path = require('path')
  let sox = require('sox.js')
  let rp = require('request-promise')

  let conn

  let cleanInput = function (input) {
    if (_.isString(input)) {
      input = input.trim().replace(config.techPrefix, '')

      if (input.length === 0) {
        return null
      }

      return input
    } else {
      return undefined
    }
  }

  let cleanNumber = function (input) {
    input = cleanInput(input)
    if (_.isString(input)) {
      try {
        let phone = phoneUtil.parse(input, 'US')
        phone = phoneUtil.format(phone, PNF.E164)
        input = phone
      } catch (err) { console.log(err) }

      return input
    } else {
      return undefined
    }
  }

  let cleanDate = function (input) {
    input = Math.round(parseInt(input, 10) / 1000)
    if (input > 0) {
      return moment(input).toDate()
    } else {
      return null
    }
  }

  let connect = function () {
    console.log('Trying to connect to FreeSwitch...')
    conn = new esl.Connection(config.host, config.port, config.password, onConnect)

    conn.on('error', function (err) {
      console.log(err)
      setTimeout(connect, 5000)
    })
  }

  let onConnect = function () {
    console.log('Connected to freeswitch...')

    conn.subscribe([
      'CHANNEL_HANGUP_COMPLETE'
    ])

    conn.on('esl::end', function () {
      connect()
    })

    conn.on('esl::event::CHANNEL_HANGUP_COMPLETE::*', async function (evt) {
      try {
        if (evt.body == null || evt.body.length === 0) {
          return
        }

        let uuid = evt.getHeader('Channel-Call-UUID')
        let cdr = await Promise.fromCallback(function (cb) { xmlParser.parseString(evt.body, cb) })
        let duration = parseInt(cdr.variables.duration, 10)

        if (duration <= 2) {
          throw new Error('call duration is too short')
        }

        if (!_.isArray(cdr.callflow)) {
          cdr.callflow = [cdr.callflow]
        }

        let callFlow = cdr.callflow.map(function (flow) {
          let callerName = _.get(flow, 'caller_profile.origination.origination_caller_profile.caller_id_name') ||
           _.get(flow, 'caller_profile.caller_id_name')
          let callerNumber = _.get(flow, 'caller_profile.origination.origination_caller_profile.caller_id_number') ||
           _.get(flow, 'caller_profile.caller_id_number')

          return {
            callerName: cleanInput(callerName),
            callerNumber: cleanNumber(callerNumber),
            calleeName: cleanInput(flow.caller_profile.callee_id_name),
            calleeNumber: cleanNumber(flow.caller_profile.callee_id_number),
            destinationNumber: cleanNumber(flow.caller_profile.destination_number),
            profileTime: cleanDate(flow.times.profile_created_time),
            hangupTime: cleanDate(flow.times.hangup_time)
          }
        }).reverse()

        let first = _.first(callFlow)
        let last = _.last(callFlow)

        let phoneNumbers = []

        if (first.destinationNumber) {
          phoneNumbers.push(first.destinationNumber)
        }

        callFlow.forEach(function (flow) {
          phoneNumbers.push(flow.callerNumber)
          phoneNumbers.push(flow.calleeNumber)
        })

        phoneNumbers = phoneNumbers.filter(function (number) {
          return _.isString(number) && number.length > 0
        })

        phoneNumbers = _.uniq(phoneNumbers)

        await Promise.delay(2000)

        let files = await Promise.fromCallback(function (cb) {
          fs.readdir(config.recordingsPath, cb)
        })

        let fileNames = files.filter(function (file) {
          return file.includes(uuid)
        })

        let deleteList = []
        let attachList = []

        let recordings = await Promise.map(fileNames, async function (fileName) {
          let wavFile = path.join(config.recordingsPath, fileName)
          let mp3File = wavFile.replace('.wav', '.mp3')
          let basename = path.basename(mp3File)

          await Promise.fromCallback(function (cb) {
            sox({
              inputFile: wavFile,
              outputFile: mp3File
            }, cb)
          })

          attachList.push(mp3File)

          deleteList.push(wavFile)
          deleteList.push(mp3File)

          return basename
        })

        let data = {
          uuid: uuid,
          callerName: first.callerName,
          callerNumber: first.callerNumber,
          calleeName: last.calleeName,
          calleeNumber: last.calleeNumber,

          destinationNumber: last.destinationNumber,
          dialedNumber: first.destinationNumber,
          duration: duration,

          phoneNumbers: phoneNumbers,
          recordings: recordings,

          callFlow: callFlow,

          startTime: first.profileTime,
          endTime: last.hangupTime
        }

        var payload = {
          method: 'POST',
          uri: config.webhook.url,
          formData: {
            data: JSON.stringify(data)
          },
          headers: config.webhook.headers
        }

        attachList.forEach(function (mp3File, idx) {
          payload.formData[`recording${idx + 1}`] = {
            value: fs.createReadStream(mp3File),
            options: {
              filename: path.basename(mp3File),
              contentType: 'audio/mp3'
            }
          }
        })

        await retry(function (retry, number) {
          return rp(payload).catch(retry)
        }, { retries: 20 })

        await Promise.map(deleteList, async function (file) {
          del(file, { force: true })
        })
      } catch (err) {
        console.error(err)
      }
    })
  }

  connect()
}
