import { ChannelMessage as HackmudChannelMessage, HackmudChatAPI, MessageType as HackmudMessageType, TellMessage as HackmudTellMessage } from "@samual/hackmud-chat-api"
import { readFile, writeFile } from "fs/promises"
import { validate, DynamicMap } from "./lib"
import { Client as DiscordClient, Guild, Message as DiscordMessage, TextChannel as DiscordTextChannel } from "discord.js"

readFile("./config.json", { encoding: "utf-8" }).then(JSON.parse).then(config => {
	if (validate(config, {
		hosts: [ "string" ],
		hackmudToken: "string",
		discordToken: "string",
		roles: {}
	})) {
		// this has to be an arrow function otherwise `config` has the `any` type
		const processDiscordMessage = (message: DiscordMessage, users: Map<string, string[]>) => {
			if (message.channel.type == "text") {
				const channelName = message.channel.topic || message.channel.name



				// let user

				let hosts = config.hosts

				// hackmudChatAPI.getChannels(true)

				// hackmudChatAPI.sendMessage(config.)
			}
		}

		// this has to be an arrow function otherwise `config` has the `any` type
		const processHackmudMessages = (messages: (HackmudChannelMessage | HackmudTellMessage)[]) => {
			const channelMessages = new DynamicMap<string, HackmudChannelMessage[]>(() => [] as HackmudChannelMessage[])

			for (const message of messages) {
				if (message.type == HackmudMessageType.Tell)
					discordChannels.get("test")?.send(`${guild!.owner}\n${processHackmudMessageText(message)}`)
				else
					channelMessages.get(message.channel).push(message)
			}

			for (const [ channelName, messages ] of channelMessages) {
				let toSend = ""

				for (const message of messages)
					toSend += processHackmudMessageText(message)

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

			return o + ":```\n" + content.replace(
				/`(?:([0-9a-zA-Z]))([^:`\n]{1,2}|[^`\n]{3,}?)`/g, // ty ducko
				(a, b, c) => c
			).replace(/```/g, "") + "```"
		}

		const hackmudChatAPI = new HackmudChatAPI(config.hackmudToken)
			.onStart(token => {
				config.hackmudToken = token

				writeFile("./config.json", JSON.stringify(config, undefined, "\t"))
				console.log("started")
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

				console.log(guild.member(guild.ownerID))
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
