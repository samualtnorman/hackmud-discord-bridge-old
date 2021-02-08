import { ChannelMessage as HackmudChannelMessage, HackmudChatAPI, MessageType as HackmudMessageType, MessageType, TellMessage as HackmudTellMessage } from "@samual/hackmud-chat-api"
import { readFile, writeFile } from "fs/promises"
import { validate, DynamicMap, asyncReplace } from "./lib"
import { Client as DiscordClient, Guild, Message as DiscordMessage, TextChannel as DiscordTextChannel, User as DiscordUser } from "discord.js"

readFile("./config.json", { encoding: "utf-8" }).then(JSON.parse).then(config => {
	if (validate(config, {
		hosts: [ "string" ],
		hackmudToken: "string",
		discordToken: "string",
		roles: {},
		colors: {}
	})) {
		const processDiscordMessage = async (message: DiscordMessage, users: Map<string, string[]>) => {
			if (message.author != discordAPI.user && message.channel.type == "text") {
				let commandResponse: string | undefined
				const channel = message.channel.topic || message.channel.name

				if (message.content.startsWith(`<@!${discordAPI.user!.id}>`)) {
					commandResponse = await processCommand(message.content.replace(`<@!${discordAPI.user!.id}> `, ""), message.author, channel)

					if (commandResponse)
						message.reply(commandResponse)
				}

				let host: string | undefined

				for (const user of config.hosts) {
					if (users.get(user)?.includes(channel)) {
						host = user
						break
					}
				}

				if (host) {
					const colours = "ABCDEFGHIJKLMNOPQSTUVWXYbcdefghijklmnopqstuvwxy"
					const id      = message.author.toString()
					const userColours = config.colors as Record<string, string>

					if (!userColours[id])
						userColours[id] = `${colours[Math.floor(Math.random() * colours.length)]}${colours[Math.floor(Math.random() * colours.length)]}`

					const promise = hackmudChatAPI.sendMessage(
						host,
						channel,
						" " + stringifyDiscordUser(message.author, true) + (await asyncReplace(
							message.content.replace(`<@!${discordAPI.user!.id}> `, ""),
							/<@!?(\d+)>/g,
							async (_, user) => "test"
						)) + "` ")

					if (commandResponse)
						// TODO mention user
						promise.then(() => hackmudChatAPI.sendMessage(host!, channel, commandResponse!))
				} else {
					message.react("❌")
					discordChannels.get("test")?.send(`<@${guild!.ownerID}> missing host in channel **${channel}**`)
				}
			}
		}

		const processHackmudMessages = (messages: (HackmudChannelMessage | HackmudTellMessage)[]) => {
			const channelMessages = new DynamicMap<string, HackmudChannelMessage[]>(() => [] as HackmudChannelMessage[])

			for (const message of messages) {
				if (message.type == HackmudMessageType.Tell)
					discordChannels.get("test")?.send(`<@${guild!.ownerID}> to ${message.toUser}\n${processHackmudMessageText(message)}`)
				else if (config.hosts.includes(message.user))
					discordChannels.get("test")?.send(`channel **${message.channel}**...\n${processHackmudMessageText(message)}`)
				else
					channelMessages.get(message.channel).push(message)
			}

			for (const [ channelName, messages ] of channelMessages) {
				let toSend = ""

				for (const message of messages) {
					switch (message.type) {
						case MessageType.Join:
							toSend += `**${message.user}** joined channel\n`
							break

						case MessageType.Leave:
							toSend += `**${message.user}** left channel\n`
							break

						case MessageType.Send:
							toSend += processHackmudMessageText(message)
							break
					}
				}

				let discordChannel = discordChannels.get(channelName)

				if (discordChannel)
					discordChannel.send(toSend)
				else
					discordChannels.get("test")?.send(`channel **${channelName}**...\n${toSend}`)
			}
		}

		const processHackmudMessageText = ({ user, content }: HackmudChannelMessage | HackmudTellMessage) => {
			let o = `**${user}**`

			const roles: string[] = []

			for (const [ role, users ] of Object.entries(config.roles as Record<string, string[]>)) {
				if (users.includes(user))
					roles.push(role)
			}

			if (roles.length)
				o += ` [${roles.join(", ")}]`

			return o + ":```\n" + content.replace(/`[^\W_]((?:(?!`|\\n).)+)`/g, (_, match) => match).replace(/`/g, "`\u200B") + "```"
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
					if (!config.hosts || !config.hosts[0])
						return "tell command not available"

					if (author instanceof DiscordUser) {
						try {
							await hackmudChatAPI.tellMessage(Array.isArray(config.hosts) ? config.hosts[0] : config.hosts, args[0], " " + stringifyDiscordUser(author, true) + args.slice(1).join(" ") + "` ")
						} catch (error) {
							return error.message
						}
					} else {
						try {
							await hackmudChatAPI.tellMessage(Array.isArray(config.hosts) ? config.hosts[0] : config.hosts, args[0], " @" + author + ": " + args.slice(1).join(" ") + " ")
						} catch (error) {
							return error.message
						}
					}

					return ""

				case "users":
					if (channel)
						return (await hackmudChatAPI.getChannels(true)).channels.get(channel)!.join(", ")

					return "what do you mean?"

				case "help":
					return readFile("./help.txt", { encoding: "utf-8" })

				default:
					return "unknown command"
			}
		}

		const stringifyDiscordUser = (user: DiscordUser, messagePre = false) => {
			console.log(user)

			const colours = "ABCDEFGHIJKLMNOPQSTUVWXYbcdefghijklmnopqstuvwxy"
			const id = user.toString()
			const userColours = config.colors as Record<string, string>

			if (!userColours[id]) {
				userColours[id] = `${colours[Math.floor(Math.random() * colours.length)]}${colours[Math.floor(Math.random() * colours.length)]}`
				writeFile("./config.json", JSON.stringify(config, undefined, "\t")).then(() => console.log("wrote config file"))
				console.log("writing config file")
			}

			if (messagePre)
				return "`" + userColours[id][0] + user.username + "``c#``C" + user.discriminator + "`: `" + userColours[id][1]

			return "`" + userColours[id][0] + user.username + "``c#``C" + user.discriminator + "`"
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

		let users: Map<string, string[]> | null = null
		const preGetChannelsMessageBuffer: DiscordMessage[] = []

		hackmudChatAPI.getChannels().then(users_ => {
			users = users_

			for (const message of preGetChannelsMessageBuffer)
				processDiscordMessage(message, users)
		})

		const discordChannels = new Map<string, DiscordTextChannel>()
		let guild: Guild | null = null
		const preDiscordReadyMessageBuffer: (HackmudChannelMessage | HackmudTellMessage)[] = []

		const discordAPI = new DiscordClient()
			.on("ready", () => {
				[ guild ] = discordAPI.guilds.cache.array()

				for (const channel of guild.channels.cache.array()) {
					if (channel.isText() && channel.type == "text")
						discordChannels.set(channel.topic || channel.name, channel)
				}

				processHackmudMessages(preDiscordReadyMessageBuffer)
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
