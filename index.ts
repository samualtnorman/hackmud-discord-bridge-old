import { ChannelMessage as HackmudChannelMessage, HackmudChatAPI, MessageType as HackmudMessageType, MessageType, TellMessage as HackmudTellMessage } from "@samual/hackmud-chat-api"
import { readFile, writeFile } from "fs/promises"
import { validate, DynamicMap, asyncReplace, matches } from "./lib"
import { Client as DiscordClient, DMChannel as DiscordDMChannel, Guild, Message as DiscordMessage, TextChannel as DiscordTextChannel, User as DiscordUser } from "discord.js"

// const hackmudValidCharacters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!\"$%^&*()`-=_+[]{}'#@~,./<>?\\|¡¢Á¤Ã¦§¨©ª▀▁▂▃▄▅▆▇█▉▊▋▌▍▎▏▐░▒▓▔▕«"

Promise.all([
	readFile("./config.json", { encoding: "utf-8" }).then(JSON.parse),
	// ./emojis.json based on https://gist.github.com/Vexs/629488c4bb4126ad2a9909309ed6bd71
	readFile("./emojis.json", { encoding: "utf-8" }).then(text => JSON.parse(text) as Record<string, string>)
]).then(async ([ config, emojis ]) => {
	if (!validate(config, {
		hosts: [ "array", [ "string" ] ],
		chatbots: [ "array", [ "string" ] ],
		ownerUsers: [ "array", [ "string" ] ],
		adminChannel: "string",
		hackmudToken: "string",
		discordToken: "string",
		roles: [ "record", [ [ "array", [ "string" ] ] ] ],
		colors: [ "record", [ "string" ] ],
		adverts: [ "array", [ "string" ] ],
		mentionNotifications: [ "record", [ [ "array", [ "string" ] ] ] ]
	})) {
		console.log("invalid config")
		return
	}

	const processDiscordMessage = async (message: DiscordMessage) => {
		if (message.author == discordAPI.user)
			return

		if (message.channel instanceof DiscordTextChannel) {
			let commandResponse: string | undefined
			const channel = message.channel.topic || message.channel.name

			channelsLastUser.delete(channel)

			const match = message.content.match(discordCommandRegex!)

			if (match) {
				commandResponse = await processCommand(match[1], message)

				if (commandResponse)
					message.reply(commandResponse)
				else
					message.react("\u2705")
			}

			if (!channel.match(/^\w{1,50}$/))
				return

			let host: string | undefined
			let messageFromOwner = message.member == guild!.owner

			if (messageFromOwner) {
				for (const user of config.ownerUsers) {
					if (usersChannels.get(user)?.includes(channel)) {
						host = user
						break
					}
				}

				if (host)
					stringifyDiscordUser(message.author)
				else
					messageFromOwner = false

			}

			if (!messageFromOwner) {
				for (const user of config.hosts) {
					if (usersChannels.get(user)?.includes(channel)) {
						host = user
						break
					}
				}
			}

			if (!host) {
				message.react("\u274C")
				adminChannel?.send(`<@${guild!.ownerID}> missing host in channel **${channel}**`)
				return
			}

			let toSend = await asyncReplace(
				processDiscordText(message.content),
				/<@!?(\d+)>/g,
				async (_, id) => stringifyDiscordUser(await discordAPI.users.fetch(id), false, channel)
			)

			if (messageFromOwner) {
				toSend = `[${config.colors[message.author.toString()][1]}${toSend} `
			} else {
				toSend = `${stringifyDiscordUser(message.author, true, channel)}${toSend} `
			}

			await hackmudChatAPI.sendMessage(host, channel, renderColor(`${toSend.includes("\n") ? "\n" : " "}${toSend}`))

			if (!commandResponse)
				return

			let chatbot: string | undefined

			for (const user of config.chatbots) {
				if (usersChannels.get(user)?.includes(channel)) {
					chatbot = user
					break
				}
			}

			if (!chatbot)
				return

			hackmudChatAPI.sendMessage(chatbot, channel, renderColor(` ${stringifyDiscordUser(message.author, false, channel)}, ${commandResponse} `))
		} else if (message.channel instanceof DiscordDMChannel) {
			const commandResponse = await processCommand(message.content.trim(), message)

			if (commandResponse)
				message.reply(commandResponse)
			else
				message.react("\u2705")
		}
	}

	const processHackmudMessages = async (messages: (HackmudChannelMessage | HackmudTellMessage)[]) => {
		const channelMessages = new DynamicMap<string, HackmudChannelMessage[]>(Array)

		for (const message of messages) {
			if (message.type == HackmudMessageType.Tell) {
				if (config.chatbots.includes(message.toUser))
					hackmudChatAPI.tellMessage(message.toUser, message.user, ` ${(await processCommand(removeColorCodes(message.content).trim(), message) || "okay")} `)
				else
					adminChannel?.send(`<@${guild!.ownerID}>, tell from **${message.user.replaceAll("_", "\\_")}** to **${message.toUser}**:${processHackmudMessageText(message, false)}`)
			} else if (config.hosts.includes(message.user) || config.chatbots.includes(message.user) || config.ownerUsers.includes(message.user))
				adminChannel?.send(`channel **${message.channel}**...\n${processHackmudMessageText(message)}`)
			else
				channelMessages.get(message.channel).push(message)
		}

		for (const [ channel, messages ] of channelMessages) {
			let toSend = ""

			for (const message of messages) {
				switch (message.type) {
					case MessageType.Join:
						toSend += `**${message.user.replaceAll("_", "\\_")}** joined channel\n`

						channelsLastUser.delete(channel)

						break

					case MessageType.Leave:
						toSend += `**${message.user.replaceAll("_", "\\_")}** left channel\n`

						channelsLastUser.delete(channel)

						break

					case MessageType.Send:
						toSend += processHackmudMessageText(message, channelsLastUser.get(channel) != message.user)

						channelsLastUser.set(channel, message.user)

						if (config.chatbots.includes(message.content.trim().slice(1).split(" ")[0])) {
							let commandResponse = await processCommand(removeColorCodes(message.content).trim().split(" ").slice(1).join(" "), message)

							if (commandResponse) {
								let chatbot: string | undefined

								for (const user of config.chatbots) {
									if (usersChannels.get(user)?.includes(channel)) {
										chatbot = user
										break
									}
								}

								commandResponse = `@${message.user}, ${commandResponse}`

								toSend += `\n${commandResponse}\n`

								if (chatbot) {
									hackmudChatAPI.sendMessage(chatbot, channel, commandResponse)
									channelsLastUser.set(channel, chatbot)
								} else
									channelsLastUser.delete(channel)
							}
						}

						break
				}
			}

			let discordChannel = discordChannels.get(channel)

			if (discordChannel)
				discordChannel.send(toSend)
			else
				adminChannel?.send(`channel **${channel}**...\n${toSend}`)
		}
	}

	const processHackmudMessageText = ({ user, content }: { user: string, content: string }, head = true) => {
		let o = ""

		if (head) {
			o += `**${user.replaceAll("_", "\\_")}**`

			const roles: string[] = []

			for (const [ role, users ] of Object.entries(config.roles)) {
				if (users.includes(user))
					roles.push(role)
			}

			if (roles.length)
				o += ` [${roles.join(", ")}]`

			o += ":"
		}

		content = removeColorCodes(content)

		if (content.split("\n").length == 1)
			content = content.trim()

		o += "```\n" + content.replace(/`/g, "`\u200B") + "```"

		const discordUsersToMention = new Set<string>()

		for (const { match } of matches(/@([a-z_][a-z_0-9]{0,24})([^a-z_0-9]|$)/g, content)) {
			const discordUsers = config.mentionNotifications[match]

			if (discordUsers) {
				for (const discordUser of discordUsers)
					discordUsersToMention.add(discordUser)
			}
		}

		return o + [ ...discordUsersToMention ].join(" ")
	}

	const processCommand = async (fullCommand: string, message: HackmudChannelMessage | HackmudTellMessage | DiscordMessage): Promise<string> => {
		const [ command, ...args ] = fullCommand.split(" ")

		let author
		let channel

		if (message instanceof DiscordMessage) {
			const discordChannel = message.channel as DiscordTextChannel

			channel = discordChannel.topic || discordChannel.name
			author = message.author
		} else {
			author = message.user

			if ("channel" in message)
				channel = message.channel
		}

		switch (command) {
			case "ping":
				return "pong!"

			case "emergency-stop":
				console.log("emergency stop")
				process.exit(1)

			case "add-role": {
				const [ role, user ] = args.join(" ").split(" to ")

				config.roles[role].push(user)
				writeFile("./config.json", JSON.stringify(config, undefined, "\t"))

				return `added @${user} to ${role} role`
			}

			case "tell":
				if (!config.hosts.length)
					return "tell command not available"

				if (config.chatbots.includes(args[0]))
					return "I know what you're up to"

				if (author instanceof DiscordUser) {
					if (config.ownerUsers.length && author.id == guild!.ownerID) {
						return hackmudChatAPI.tellMessage(
							config.ownerUsers[0],
							args[0],
							renderColor(` ${processDiscordText(args.slice(1).join(" "))} `)
						).then(() => "", ({ message }) => message)
					} else {
						return hackmudChatAPI.tellMessage(
							config.hosts[0],
							args[0],
							renderColor(` ${stringifyDiscordUser(author, true, channel)}${processDiscordText(args.slice(1).join(" "))} `)
						).then(() => "", ({ message }) => message)
					}
				} else
					return hackmudChatAPI.tellMessage(config.hosts[0], args[0], " @" + author + ": " + args.slice(1).join(" ") + " ").then(() => "", ({ message }) => message)

			case "users":
				if (channel == config.adminChannel) {
					let o = "users:\n"
					const usersNotInChannel: string[] = []

					for (const [ user, channels ] of (await hackmudChatAPI.getChannels())) {
						if (channels.length)
							o += `**${user}**:\n${channels.map(channel => {
								let o = `\t- ${channel}`

								const discordChannel = discordChannels.get(channel)

								if (discordChannel)
									o += ` ${discordChannel}`

								return o
							}).join("\n")}\n\n`
						else
							usersNotInChannel.push(`**${user}**`)
					}

					return `${o}\nnot in channel: ${usersNotInChannel.join(", ")}`
				}

				if (channel)
					return (await hackmudChatAPI.getChannels(true)).channels.get(channel)!.join(", ")

				return "what do you mean?"

			case "add-advert": {
				const advert = args.join(" ")

				config.adverts.push(advert)
				writeFile("./config.json", JSON.stringify(config, undefined, "\t"))

				return "added:```\n" + advert + "```"
			}

			case "help":
				return readFile("./help.txt", { encoding: "utf-8" })

			case "notify-me-for": {
				if (typeof author == "string")
					return "I don't support that"

				if (!args.length)
					return "I need a name"

				for (const user of args)
					(config.mentionNotifications[user] = config.mentionNotifications[user] || []).push(author.toString())

				writeFile("./config.json", JSON.stringify(config, undefined, "\t"))

				return `I will notify your for ${args.join(", ")}`
			}

			case "set-admin-channel": {
				let discordChannel

				if (message instanceof DiscordMessage)
					discordChannel = message.channel as DiscordTextChannel
				else if (channel)
					discordChannel = discordChannels.get(channel)

				if (discordChannel) {
					adminChannel = discordChannel
					config.adminChannel = adminChannel.id

					writeFile("./config.json", JSON.stringify(config, undefined, "\t"))

					return "set this channel as the admin channel"
				}

				return "did not set the admin channel"
			}

			case "set-user-color": {
				if (!(message instanceof DiscordMessage))
					return "I can only set the user color of discord users"

				if (!args[0] || !args[0].match(/^[a-zA-Z]$/))
					return "I need the color code (a-z, A-Z)"

				stringifyDiscordUser(message.author)

				const id = message.author.toString()

				config.colors[id] = `${args[0]}${config.colors[id][1]}`

				writeFile("./config.json", JSON.stringify(config, undefined, "\t"))

				return ""
			}

			case "set-text-color": {
				if (!(message instanceof DiscordMessage))
					return "I can only set the text color of discord users"

				if (!args[0] || !args[0].match(/^[a-zA-Z]$/))
					return "I need the color code (a-z, A-Z)"

				stringifyDiscordUser(message.author)

				const id = message.author.toString()

				config.colors[id] = `${config.colors[id][0]}${args[0]}`

				writeFile("./config.json", JSON.stringify(config, undefined, "\t"))

				return ""
			}

			default:
				return "unknown command"
		}
	}

	const stringifyDiscordUser = (user: DiscordUser, messagePre = false, channel?: string) => {
		let users = {
			[discordAPI.user!.id]: config.chatbots,
			[guild!.ownerID]: config.ownerUsers
		}[user.id]

		if (users) {
			if (!channel)
				return `@${users[0]}`

			for (const user of users) {
				if (usersChannels.get(user)?.includes(channel))
					return `@${user}`
			}
		}

		const colours = "ABCDEFGHIJKLMNOPQSTUVWXYbcdefghijklmnopqstuvwxy"
		const id = user.toString()

		if (!config.colors[id]) {
			config.colors[id] = `${colours[Math.floor(Math.random() * colours.length)]}${colours[Math.floor(Math.random() * colours.length)]}`
			writeFile("./config.json", JSON.stringify(config, undefined, "\t"))
		}

		if (messagePre)
			return `[${config.colors[id][0]}${user.username}][c#][C${user.discriminator}]: [${config.colors[id][1]}`

		return `[${config.colors[id][0]}${user.username}][c#][C${user.discriminator}]`
	}

	const reloadConfigLoop = () => {
		// setTimeout(async () => {
		// 	let configTemp = JSON.parse(await readFile("./config.json", { encoding: "utf-8" }))

		// 	if (validate(config, {
		// 		hosts: [ "string" ],
		// 		hackmudToken: "string",
		// 		discordToken: "string",
		// 		roles: {},
		// 		colors: {},
		// 		adverts: [ "string" ]
		// 	}))
		// 		config = configTemp

		// 	reloadConfigLoop()
		// }, 5000)
	}

	const advertLoop = () => {
		setTimeout(() => {
			if (config.adverts.length) {
				let chatbot: string | undefined

				for (const user of config.chatbots) {
					if (usersChannels.get(user)?.includes("0000")) {
						chatbot = user
						break
					}
				}

				if (chatbot) {
					const advert = config.adverts[Math.floor(Math.random() * config.adverts.length)]

					hackmudChatAPI.sendMessage(chatbot, "0000", advert)
					discordChannels.get("0000")?.send(processHackmudMessageText({ user: chatbot, content: advert }, channelsLastUser.get("0000") != chatbot))
					channelsLastUser.set("0000", chatbot)
				}
			}

			advertLoop()
		}, Math.floor(Math.random() * 3600000) + 1800000)
	}

	const processDiscordText = (text: string) => {
		return text
			.replace(
				// emoji regex taken from https://github.com/twitter/twemoji/blob/v12.0.1/2/twemoji.js#L228
				/(?:\ud83d\udc68\ud83c\udffc\u200d\ud83e\udd1d\u200d\ud83d\udc68\ud83c\udffb|\ud83d\udc68\ud83c\udffd\u200d\ud83e\udd1d\u200d\ud83d\udc68\ud83c[\udffb\udffc]|\ud83d\udc68\ud83c\udffe\u200d\ud83e\udd1d\u200d\ud83d\udc68\ud83c[\udffb-\udffd]|\ud83d\udc68\ud83c\udfff\u200d\ud83e\udd1d\u200d\ud83d\udc68\ud83c[\udffb-\udffe]|\ud83d\udc69\ud83c\udffb\u200d\ud83e\udd1d\u200d\ud83d\udc68\ud83c[\udffc-\udfff]|\ud83d\udc69\ud83c\udffc\u200d\ud83e\udd1d\u200d\ud83d\udc68\ud83c[\udffb\udffd-\udfff]|\ud83d\udc69\ud83c\udffc\u200d\ud83e\udd1d\u200d\ud83d\udc69\ud83c\udffb|\ud83d\udc69\ud83c\udffd\u200d\ud83e\udd1d\u200d\ud83d\udc68\ud83c[\udffb\udffc\udffe\udfff]|\ud83d\udc69\ud83c\udffd\u200d\ud83e\udd1d\u200d\ud83d\udc69\ud83c[\udffb\udffc]|\ud83d\udc69\ud83c\udffe\u200d\ud83e\udd1d\u200d\ud83d\udc68\ud83c[\udffb-\udffd\udfff]|\ud83d\udc69\ud83c\udffe\u200d\ud83e\udd1d\u200d\ud83d\udc69\ud83c[\udffb-\udffd]|\ud83d\udc69\ud83c\udfff\u200d\ud83e\udd1d\u200d\ud83d\udc68\ud83c[\udffb-\udffe]|\ud83d\udc69\ud83c\udfff\u200d\ud83e\udd1d\u200d\ud83d\udc69\ud83c[\udffb-\udffe]|\ud83e\uddd1\ud83c\udffb\u200d\ud83e\udd1d\u200d\ud83e\uddd1\ud83c\udffb|\ud83e\uddd1\ud83c\udffc\u200d\ud83e\udd1d\u200d\ud83e\uddd1\ud83c[\udffb\udffc]|\ud83e\uddd1\ud83c\udffd\u200d\ud83e\udd1d\u200d\ud83e\uddd1\ud83c[\udffb-\udffd]|\ud83e\uddd1\ud83c\udffe\u200d\ud83e\udd1d\u200d\ud83e\uddd1\ud83c[\udffb-\udffe]|\ud83e\uddd1\ud83c\udfff\u200d\ud83e\udd1d\u200d\ud83e\uddd1\ud83c[\udffb-\udfff]|\ud83e\uddd1\u200d\ud83e\udd1d\u200d\ud83e\uddd1|\ud83d\udc6b\ud83c[\udffb-\udfff]|\ud83d\udc6c\ud83c[\udffb-\udfff]|\ud83d\udc6d\ud83c[\udffb-\udfff]|\ud83d[\udc6b-\udc6d])|(?:\ud83d[\udc68\udc69])(?:\ud83c[\udffb-\udfff])?\u200d(?:\u2695\ufe0f|\u2696\ufe0f|\u2708\ufe0f|\ud83c[\udf3e\udf73\udf93\udfa4\udfa8\udfeb\udfed]|\ud83d[\udcbb\udcbc\udd27\udd2c\ude80\ude92]|\ud83e[\uddaf-\uddb3\uddbc\uddbd])|(?:\ud83c[\udfcb\udfcc]|\ud83d[\udd74\udd75]|\u26f9)((?:\ud83c[\udffb-\udfff]|\ufe0f)\u200d[\u2640\u2642]\ufe0f)|(?:\ud83c[\udfc3\udfc4\udfca]|\ud83d[\udc6e\udc71\udc73\udc77\udc81\udc82\udc86\udc87\ude45-\ude47\ude4b\ude4d\ude4e\udea3\udeb4-\udeb6]|\ud83e[\udd26\udd35\udd37-\udd39\udd3d\udd3e\uddb8\uddb9\uddcd-\uddcf\uddd6-\udddd])(?:\ud83c[\udffb-\udfff])?\u200d[\u2640\u2642]\ufe0f|(?:\ud83d\udc68\u200d\u2764\ufe0f\u200d\ud83d\udc8b\u200d\ud83d\udc68|\ud83d\udc68\u200d\ud83d\udc68\u200d\ud83d\udc66\u200d\ud83d\udc66|\ud83d\udc68\u200d\ud83d\udc68\u200d\ud83d\udc67\u200d\ud83d[\udc66\udc67]|\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc66\u200d\ud83d\udc66|\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67\u200d\ud83d[\udc66\udc67]|\ud83d\udc69\u200d\u2764\ufe0f\u200d\ud83d\udc8b\u200d\ud83d[\udc68\udc69]|\ud83d\udc69\u200d\ud83d\udc69\u200d\ud83d\udc66\u200d\ud83d\udc66|\ud83d\udc69\u200d\ud83d\udc69\u200d\ud83d\udc67\u200d\ud83d[\udc66\udc67]|\ud83d\udc68\u200d\u2764\ufe0f\u200d\ud83d\udc68|\ud83d\udc68\u200d\ud83d\udc66\u200d\ud83d\udc66|\ud83d\udc68\u200d\ud83d\udc67\u200d\ud83d[\udc66\udc67]|\ud83d\udc68\u200d\ud83d\udc68\u200d\ud83d[\udc66\udc67]|\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d[\udc66\udc67]|\ud83d\udc69\u200d\u2764\ufe0f\u200d\ud83d[\udc68\udc69]|\ud83d\udc69\u200d\ud83d\udc66\u200d\ud83d\udc66|\ud83d\udc69\u200d\ud83d\udc67\u200d\ud83d[\udc66\udc67]|\ud83d\udc69\u200d\ud83d\udc69\u200d\ud83d[\udc66\udc67]|\ud83c\udff3\ufe0f\u200d\ud83c\udf08|\ud83c\udff4\u200d\u2620\ufe0f|\ud83d\udc15\u200d\ud83e\uddba|\ud83d\udc41\u200d\ud83d\udde8|\ud83d\udc68\u200d\ud83d[\udc66\udc67]|\ud83d\udc69\u200d\ud83d[\udc66\udc67]|\ud83d\udc6f\u200d\u2640\ufe0f|\ud83d\udc6f\u200d\u2642\ufe0f|\ud83e\udd3c\u200d\u2640\ufe0f|\ud83e\udd3c\u200d\u2642\ufe0f|\ud83e\uddde\u200d\u2640\ufe0f|\ud83e\uddde\u200d\u2642\ufe0f|\ud83e\udddf\u200d\u2640\ufe0f|\ud83e\udddf\u200d\u2642\ufe0f)|[#*0-9]\ufe0f?\u20e3|(?:[©®\u2122\u265f]\ufe0f)|(?:\ud83c[\udc04\udd70\udd71\udd7e\udd7f\ude02\ude1a\ude2f\ude37\udf21\udf24-\udf2c\udf36\udf7d\udf96\udf97\udf99-\udf9b\udf9e\udf9f\udfcd\udfce\udfd4-\udfdf\udff3\udff5\udff7]|\ud83d[\udc3f\udc41\udcfd\udd49\udd4a\udd6f\udd70\udd73\udd76-\udd79\udd87\udd8a-\udd8d\udda5\udda8\uddb1\uddb2\uddbc\uddc2-\uddc4\uddd1-\uddd3\udddc-\uddde\udde1\udde3\udde8\uddef\uddf3\uddfa\udecb\udecd-\udecf\udee0-\udee5\udee9\udef0\udef3]|[\u203c\u2049\u2139\u2194-\u2199\u21a9\u21aa\u231a\u231b\u2328\u23cf\u23ed-\u23ef\u23f1\u23f2\u23f8-\u23fa\u24c2\u25aa\u25ab\u25b6\u25c0\u25fb-\u25fe\u2600-\u2604\u260e\u2611\u2614\u2615\u2618\u2620\u2622\u2623\u2626\u262a\u262e\u262f\u2638-\u263a\u2640\u2642\u2648-\u2653\u2660\u2663\u2665\u2666\u2668\u267b\u267f\u2692-\u2697\u2699\u269b\u269c\u26a0\u26a1\u26aa\u26ab\u26b0\u26b1\u26bd\u26be\u26c4\u26c5\u26c8\u26cf\u26d1\u26d3\u26d4\u26e9\u26ea\u26f0-\u26f5\u26f8\u26fa\u26fd\u2702\u2708\u2709\u270f\u2712\u2714\u2716\u271d\u2721\u2733\u2734\u2744\u2747\u2757\u2763\u2764\u27a1\u2934\u2935\u2b05-\u2b07\u2b1b\u2b1c\u2b50\u2b55\u3030\u303d\u3297\u3299])(?:\ufe0f|(?!\ufe0e))|(?:(?:\ud83c[\udfcb\udfcc]|\ud83d[\udd74\udd75\udd90]|[\u261d\u26f7\u26f9\u270c\u270d])(?:\ufe0f|(?!\ufe0e))|(?:\ud83c[\udf85\udfc2-\udfc4\udfc7\udfca]|\ud83d[\udc42\udc43\udc46-\udc50\udc66-\udc69\udc6e\udc70-\udc78\udc7c\udc81-\udc83\udc85-\udc87\udcaa\udd7a\udd95\udd96\ude45-\ude47\ude4b-\ude4f\udea3\udeb4-\udeb6\udec0\udecc]|\ud83e[\udd0f\udd18-\udd1c\udd1e\udd1f\udd26\udd30-\udd39\udd3d\udd3e\uddb5\uddb6\uddb8\uddb9\uddbb\uddcd-\uddcf\uddd1-\udddd]|[\u270a\u270b]))(?:\ud83c[\udffb-\udfff])?|(?:\ud83c\udff4\udb40\udc67\udb40\udc62\udb40\udc65\udb40\udc6e\udb40\udc67\udb40\udc7f|\ud83c\udff4\udb40\udc67\udb40\udc62\udb40\udc73\udb40\udc63\udb40\udc74\udb40\udc7f|\ud83c\udff4\udb40\udc67\udb40\udc62\udb40\udc77\udb40\udc6c\udb40\udc73\udb40\udc7f|\ud83c\udde6\ud83c[\udde8-\uddec\uddee\uddf1\uddf2\uddf4\uddf6-\uddfa\uddfc\uddfd\uddff]|\ud83c\udde7\ud83c[\udde6\udde7\udde9-\uddef\uddf1-\uddf4\uddf6-\uddf9\uddfb\uddfc\uddfe\uddff]|\ud83c\udde8\ud83c[\udde6\udde8\udde9\uddeb-\uddee\uddf0-\uddf5\uddf7\uddfa-\uddff]|\ud83c\udde9\ud83c[\uddea\uddec\uddef\uddf0\uddf2\uddf4\uddff]|\ud83c\uddea\ud83c[\udde6\udde8\uddea\uddec\udded\uddf7-\uddfa]|\ud83c\uddeb\ud83c[\uddee-\uddf0\uddf2\uddf4\uddf7]|\ud83c\uddec\ud83c[\udde6\udde7\udde9-\uddee\uddf1-\uddf3\uddf5-\uddfa\uddfc\uddfe]|\ud83c\udded\ud83c[\uddf0\uddf2\uddf3\uddf7\uddf9\uddfa]|\ud83c\uddee\ud83c[\udde8-\uddea\uddf1-\uddf4\uddf6-\uddf9]|\ud83c\uddef\ud83c[\uddea\uddf2\uddf4\uddf5]|\ud83c\uddf0\ud83c[\uddea\uddec-\uddee\uddf2\uddf3\uddf5\uddf7\uddfc\uddfe\uddff]|\ud83c\uddf1\ud83c[\udde6-\udde8\uddee\uddf0\uddf7-\uddfb\uddfe]|\ud83c\uddf2\ud83c[\udde6\udde8-\udded\uddf0-\uddff]|\ud83c\uddf3\ud83c[\udde6\udde8\uddea-\uddec\uddee\uddf1\uddf4\uddf5\uddf7\uddfa\uddff]|\ud83c\uddf4\ud83c\uddf2|\ud83c\uddf5\ud83c[\udde6\uddea-\udded\uddf0-\uddf3\uddf7-\uddf9\uddfc\uddfe]|\ud83c\uddf6\ud83c\udde6|\ud83c\uddf7\ud83c[\uddea\uddf4\uddf8\uddfa\uddfc]|\ud83c\uddf8\ud83c[\udde6-\uddea\uddec-\uddf4\uddf7-\uddf9\uddfb\uddfd-\uddff]|\ud83c\uddf9\ud83c[\udde6\udde8\udde9\uddeb-\udded\uddef-\uddf4\uddf7\uddf9\uddfb\uddfc\uddff]|\ud83c\uddfa\ud83c[\udde6\uddec\uddf2\uddf3\uddf8\uddfe\uddff]|\ud83c\uddfb\ud83c[\udde6\udde8\uddea\uddec\uddee\uddf3\uddfa]|\ud83c\uddfc\ud83c[\uddeb\uddf8]|\ud83c\uddfd\ud83c\uddf0|\ud83c\uddfe\ud83c[\uddea\uddf9]|\ud83c\uddff\ud83c[\udde6\uddf2\uddfc]|\ud83c[\udccf\udd8e\udd91-\udd9a\udde6-\uddff\ude01\ude32-\ude36\ude38-\ude3a\ude50\ude51\udf00-\udf20\udf2d-\udf35\udf37-\udf7c\udf7e-\udf84\udf86-\udf93\udfa0-\udfc1\udfc5\udfc6\udfc8\udfc9\udfcf-\udfd3\udfe0-\udff0\udff4\udff8-\udfff]|\ud83d[\udc00-\udc3e\udc40\udc44\udc45\udc51-\udc65\udc6a-\udc6d\udc6f\udc79-\udc7b\udc7d-\udc80\udc84\udc88-\udca9\udcab-\udcfc\udcff-\udd3d\udd4b-\udd4e\udd50-\udd67\udda4\uddfb-\ude44\ude48-\ude4a\ude80-\udea2\udea4-\udeb3\udeb7-\udebf\udec1-\udec5\uded0-\uded2\uded5\udeeb\udeec\udef4-\udefa\udfe0-\udfeb]|\ud83e[\udd0d\udd0e\udd10-\udd17\udd1d\udd20-\udd25\udd27-\udd2f\udd3a\udd3c\udd3f-\udd45\udd47-\udd71\udd73-\udd76\udd7a-\udda2\udda5-\uddaa\uddae-\uddb4\uddb7\uddba\uddbc-\uddca\uddd0\uddde-\uddff\ude70-\ude73\ude78-\ude7a\ude80-\ude82\ude90-\ude95]|[\u23e9-\u23ec\u23f0\u23f3\u267e\u26ce\u2705\u2728\u274c\u274e\u2753-\u2755\u2795-\u2797\u27b0\u27bf\ue50a])|\ufe0f/g,
				match => `:${emojis[match]}:`
			).replace(
				/<:(\w{2,32}):\d{17,19}>/g,
				(_, match) => `:${match}:`
			).replaceAll("`", "«")
			.replaceAll("\\", "\\\\")
			.replaceAll("[", "\\[")
			.replaceAll("]", "\\]")
	}

	const preGetChannelsMessageBuffer: DiscordMessage[] = []
	const discordChannels = new Map<string, DiscordTextChannel>()
	const preDiscordReadyMessageBuffer: (HackmudChannelMessage | HackmudTellMessage)[] = []
	const channelsLastUser = new Map<string, string>()
	let guild: Guild | null = null
	let adminChannel: DiscordTextChannel | undefined

	const hackmudChatAPI = new HackmudChatAPI(config.hackmudToken)
		.onStart(token => {
			config.hackmudToken = token

			writeFile("./config.json", JSON.stringify(config, undefined, "\t"))
		})
		.onMessage(messages => {
			if (guild)
				processHackmudMessages(messages)
			else
				preDiscordReadyMessageBuffer.push(...messages)
		})

	let discordCommandRegex: RegExp | undefined

	const discordAPI = new DiscordClient({ retryLimit: 4 })
		.on("ready", () => {
			discordCommandRegex = new RegExp(`^ *<@!?${discordAPI.user!.id}>,? *(.+)`)

			;[ guild ] = discordAPI.guilds.cache.array()

			for (const channel of guild.channels.cache.array()) {
				if (channel instanceof DiscordTextChannel)
					discordChannels.set(channel.topic || channel.name, channel)
			}

			const adminChannel_ = guild.channels.resolve(config.adminChannel)

			if (adminChannel_ instanceof DiscordTextChannel)
				adminChannel = adminChannel_

			processHackmudMessages(preDiscordReadyMessageBuffer)

			preDiscordReadyMessageBuffer.length = 0
		})
		.on("message", preGetChannelsOnMessageEventListener)

	discordAPI.login(config.discordToken)

	const usersChannels = await hackmudChatAPI.getChannels()

	for (const message of preGetChannelsMessageBuffer)
		processDiscordMessage(message)

	preGetChannelsMessageBuffer.length = 0

	discordAPI.removeListener("message", preGetChannelsOnMessageEventListener)
	discordAPI.on("message", processDiscordMessage)

	reloadConfigLoop()
	advertLoop()

	function preGetChannelsOnMessageEventListener(message: DiscordMessage) {
		preGetChannelsMessageBuffer.push(message)
	}
})

function renderColor(text: string) {
	const data = text.split("")
	const colourStack: string[] = []
	let o = ""
	let unopened = false

	while (data.length) {
		const char = data.shift()

		switch (char) {
			case "[": {
				const nextChar = data.shift()

				if (nextChar?.match(/[a-zA-Z0-9]/)) {
					if (colourStack.length && !unopened)
						o += "`"

					unopened = true

					colourStack.push(nextChar)
				} else
					o += "`" + (nextChar || "")
			} break

			case "]":
				if (!colourStack.length)
					o += "]"
				else {
					if (!unopened)
						o += "`"

					colourStack.pop()

					unopened = true
				}

				break

			case " ":
				o += " "
				break

			case "\\":
				if (unopened && colourStack.length) {
					o += "`" + colourStack[colourStack.length - 1]
					unopened = false
				}

				o += data.shift()

				break

			case "\n":
				if (colourStack.length && !unopened) {
					o += "`"
					unopened = true
				}

				o += "\n"

				break

			default:
				if (unopened && colourStack.length) {
					o += "`" + colourStack[colourStack.length - 1]
					unopened = false
				}

				o += char
		}
	}

	if (colourStack.length && !unopened)
		o += "`"

	return o
}

function removeColorCodes(text: string) {
	return text.replace(/`[^\W_]((?:(?!`|\\n).)+)`/g, "$1")
}
