import { ChannelMessage as HackmudChannelMessage, HackmudChatAPI, MessageType as HackmudMessageType, MessageType, TellMessage as HackmudTellMessage } from "@samual/hackmud-chat-api"
import { readFile, writeFile } from "fs/promises"
import { validate, DynamicMap, asyncReplace } from "./lib"
import { Client as DiscordClient, Guild, Message as DiscordMessage, TextChannel as DiscordTextChannel, User as DiscordUser } from "discord.js"

// const hackmudValidCharacters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!\"$%^&*()`-=_+[]{}'#@~,./<>?\\|¡¢Á¤Ã¦§¨©ª▀▁▂▃▄▅▆▇█▉▊▋▌▍▎▏▐░▒▓▔▕«"

readFile("./config.json", { encoding: "utf-8" }).then(JSON.parse).then(config => {
	if (validate(config, {
		host: [ "string" ],
		chatbot: [ "string" ],
		adminChannel: "string",
		hackmudToken: "string",
		discordToken: "string",
		roles: {},
		colors: {},
		advert: [ "string" ]
	})) {
		let hosts: string[]

		if (typeof config.host == "string")
			hosts = [ config.host ]
		else
			hosts = config.host

		let chatbots: string[]

		if (typeof config.chatbot == "string")
			chatbots = [ config.chatbot ]
		else
			chatbots = config.chatbot

		let adverts: string[]

		if (typeof config.advert == "string")
			adverts = [ config.advert ]
		else
			adverts = config.advert

		const processDiscordMessage = async (message: DiscordMessage, users: Map<string, string[]>) => {
			if (message.author != discordAPI.user && message.channel.type == "text") {
				let commandResponse: string | undefined
				const channel = message.channel.topic || message.channel.name

				channelsLastUser.delete(channel)

				if (message.content.startsWith(`<@!${discordAPI.user!.id}>`)) {
					commandResponse = await processCommand(message.content.replace(`<@!${discordAPI.user!.id}> `, ""), message.author, channel)

					if (commandResponse)
						message.reply(commandResponse)
				}

				if (channel.match(/^\w{1,50}$/)) {
					let host: string | undefined

					for (const user of hosts) {
						if (users.get(user)?.includes(channel)) {
							host = user
							break
						}
					}

					if (host) {
						const promise = hackmudChatAPI.sendMessage(
							host,
							channel,
							renderColour(` ${stringifyDiscordUser(message.author, true)}${await asyncReplace(
								message.content.replaceAll("`", "«").replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]"),
								/<@!?(\d+)>/g,
								async (_, id) => stringifyDiscordUser(await discordAPI.users.fetch(id))
							)} `)
						)

						if (commandResponse) {
							let chatbot: string | undefined

							for (const user of chatbots) {
								if (users.get(user)?.includes(channel)) {
									chatbot = user
									break
								}
							}

							promise.then(() => hackmudChatAPI.sendMessage(chatbot!, channel, renderColour(`${stringifyDiscordUser(message.author)}, ${commandResponse}`)))
						}
					} else {
						message.react("\u274C")
						discordChannels.get(config.adminChannel)?.send(`<@${guild!.ownerID}> missing host in channel **${channel}**`)
					}
				}
			}
		}

		const processHackmudMessages = async (messages: (HackmudChannelMessage | HackmudTellMessage)[]) => {
			const channelMessages = new DynamicMap<string, HackmudChannelMessage[]>(() => [] as HackmudChannelMessage[])

			for (const message of messages) {
				if (message.type == HackmudMessageType.Tell)
					discordChannels.get(config.adminChannel)?.send(`<@${guild!.ownerID}>, tell from **${message.user.replaceAll("_", "\\_")}** to **${message.toUser}**:${processHackmudMessageText(message, false)}`)
				else if (hosts.includes(message.user) || chatbots.includes(message.user))
					discordChannels.get(config.adminChannel)?.send(`channel **${message.channel}**...\n${processHackmudMessageText(message)}`)
				else
					channelMessages.get(message.channel).push(message)
			}

			for (const [ channel, messages ] of channelMessages) {
				let toSend = ""

				for (const message of messages) {
					switch (message.type) {
						case MessageType.Join:
							toSend += `**${message.user.replaceAll("_", "\\_")}** joined channel\n`

							channelsLastUser.set(channel, message.user)

							break

						case MessageType.Leave:
							toSend += `**${message.user.replaceAll("_", "\\_")}** left channel\n`

							channelsLastUser.set(channel, message.user)

							break

						case MessageType.Send:
							toSend += processHackmudMessageText(message, channelsLastUser.get(channel) != message.user)

							channelsLastUser.set(channel, message.user)

							if (chatbots.includes(message.content.trim().slice(1).split(" ")[0])) {
								let commandResponse = await processCommand(message.content.trim().split(" ").slice(1).join(" "), message.user, channel)

								if (commandResponse) {
									let chatbot: string | undefined

									for (const user of chatbots) {
										if (users!.get(user)?.includes(channel)) {
											chatbot = user
											break
										}
									}

									commandResponse = `@${message.user}, ${commandResponse}`

									toSend += `\n${commandResponse}\n`

									if (chatbot)
										hackmudChatAPI.sendMessage(chatbot, channel, commandResponse)

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
					discordChannels.get(config.adminChannel)?.send(`channel **${channel}**...\n${toSend}`)
			}
		}

		const processHackmudMessageText = ({ user, content }: { user: string, content: string }, head = true) => {
			let o = ""

			if (head) {
				o += `**${user}**`

				const roles: string[] = []

				for (const [ role, users ] of Object.entries(config.roles as Record<string, string[]>)) {
					if (users.includes(user))
						roles.push(role)
				}

				if (roles.length)
					o += ` [${roles.join(", ")}]`

				o += ":"
			}

			return o + "```\n" + content.replace(/`[^\W_]((?:(?!`|\\n).)+)`/g, (_, match) => match).replace(/`/g, "`\u200B") + "```"
		}


		const processCommand = async (fullCommand: string, author: DiscordUser | string, channel?: string): Promise<string> => {
			const [ command, ...args ] = fullCommand.split(" ")

			switch (command) {
				case "ping":
					return "pong!"

				case "emergency-stop":
					console.log("emergency stop")
					process.exit(1)

				case "add-role":
					const [ role, user ] = args.join(" ").split(" to ")
					;(config.roles as Record<string, string[]>)[role].push(user)
					writeFile("./config.json", JSON.stringify(config, undefined, "\t"))
					return `added @${user} to ${role} role`

				case "tell":
					if (!hosts.length)
						return "tell command not available"

					if (author instanceof DiscordUser) {
						try {
							await hackmudChatAPI.tellMessage(
								hosts[0], args[0],
								renderColour(` ${stringifyDiscordUser(author, true)}${args.slice(1).join(" ").replaceAll("`", "«").replaceAll("\\", "\\\\").replaceAll("[", "\\[").replaceAll("]", "\\]")} `)
							)
						} catch (error) {
							return error.message
						}
					} else {
						try {
							await hackmudChatAPI.tellMessage(hosts[0], args[0], " @" + author + ": " + args.slice(1).join(" ") + " ")
						} catch (error) {
							return error.message
						}
					}

					return ""

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

				case "add-advert":
					const advert = args.join(" ")

					adverts.push(advert)
					config.advert = adverts
					writeFile("./config.json", JSON.stringify(config, undefined, "\t"))

					return "added:```\n" + advert + "```"

				case "help":
					return readFile("./help.txt", { encoding: "utf-8" })

				default:
					return "unknown command"
			}
		}

		const stringifyDiscordUser = (user: DiscordUser, messagePre = false) => {
			const colours = "ABCDEFGHIJKLMNOPQSTUVWXYbcdefghijklmnopqstuvwxy"
			const id = user.toString()
			const userColours = config.colors as Record<string, string>

			if (!userColours[id]) {
				userColours[id] = `${colours[Math.floor(Math.random() * colours.length)]}${colours[Math.floor(Math.random() * colours.length)]}`
				writeFile("./config.json", JSON.stringify(config, undefined, "\t")).then(() => console.log("wrote config file"))
				console.log("writing config file")
			}

			if (messagePre)
				return `[${userColours[id][0]}${user.username}][c#][C${user.discriminator}]: [${userColours[id][1]}`

			return `[${userColours[id][0]}${user.username}][c#][C${user.discriminator}]`
		}

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
				if (adverts.length) {
					let chatbot: string | undefined

					for (const user of chatbots) {
						if (users!.get(user)?.includes("0000")) {
							chatbot = user
							break
						}
					}

					if (chatbot) {
						const advert = adverts[Math.floor(Math.random() * adverts.length)]

						hackmudChatAPI.sendMessage(chatbot, "0000", advert)
						discordChannels.get("0000")?.send(processHackmudMessageText({ user: chatbot, content: advert }))
						channelsLastUser.delete("0000")
					}
				}

				advertLoop()
			}, Math.floor(Math.random() * 3600000) + 1800000)
		}

		let users: Map<string, string[]> | null = null
		const preGetChannelsMessageBuffer: DiscordMessage[] = []

		hackmudChatAPI.getChannels().then(users_ => {
			users = users_

			for (const message of preGetChannelsMessageBuffer)
				processDiscordMessage(message, users)

			preGetChannelsMessageBuffer.length = 0

			reloadConfigLoop()
			advertLoop()
		})

		const discordChannels = new Map<string, DiscordTextChannel>()
		let guild: Guild | null = null
		const preDiscordReadyMessageBuffer: (HackmudChannelMessage | HackmudTellMessage)[] = []

		const channelsLastUser = new Map<string, string>()

		const discordAPI = new DiscordClient({ retryLimit: 4 })
			.on("ready", async () => {
				[ guild ] = discordAPI.guilds.cache.array()

				for (const channel of guild.channels.cache.array()) {
					if (channel.isText() && channel.type == "text")
						discordChannels.set(channel.topic || channel.name, channel)
				}

				processHackmudMessages(preDiscordReadyMessageBuffer)
				preDiscordReadyMessageBuffer.length = 0
			})
			.on("message", message => {
				// TODO process messages as much as we can before sending them to the buffer

				if (users)
					processDiscordMessage(message, users)
				else
					preGetChannelsMessageBuffer.push(message)
			})

		discordAPI.login(config.discordToken)
	} else
		console.log("invalid config")
})

function renderColour(text: string) {
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
