import { ChannelMessage as HackmudChannelMessage, HackmudChatAPI, MessageType as HackmudMessageType, MessageType, TellMessage as HackmudTellMessage } from "@samual/hackmud-chat-api"
import { readFile, writeFile } from "fs/promises"
import { validate, DynamicMap, asyncReplace, matches } from "./lib"
import { Client as DiscordClient, DMChannel as DiscordDMChannel, Guild, Message as DiscordMessage, TextChannel as DiscordTextChannel, User as DiscordUser } from "discord.js"

// const hackmudValidCharacters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!\"$%^&*()`-=_+[]{}'#@~,./<>?\\|¡¢Á¤Ã¦§¨©ª▀▁▂▃▄▅▆▇█▉▊▋▌▍▎▏▐░▒▓▔▕«"

readFile("./config.json", { encoding: "utf-8" }).then(JSON.parse).then(async config => {
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
				toSend = ` [${config.colors[message.author.toString()][1]}${toSend} `
			} else {
				toSend = ` ${stringifyDiscordUser(message.author, true, channel)}${toSend} `
			}

			await hackmudChatAPI.sendMessage(host, channel, renderColor(toSend))

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

function processDiscordText(text: string) {
	return text.replaceAll("`", "«").replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]")
}
