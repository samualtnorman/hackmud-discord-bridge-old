import { HackmudChatAPI } from "@samual/hackmud-chat-api"
import { readFile, writeFile } from "fs/promises"
import { validate } from "./lib"

readFile("./config.json", { encoding: "utf-8" }).then(JSON.parse).then(config => {
	if (validate(config, {
		host: "string",
		hackmudToken: "string",
		discordToken: "string"
	})) {
		const hackmudChatAPI = new HackmudChatAPI(config.hackmudToken)

		hackmudChatAPI.onStart(token => {
			config.hackmudToken = token

			writeFile("./config.json", JSON.stringify(config, undefined, "\t"))

			console.log("started")
		})

		hackmudChatAPI.onMessage(messages => {
			for (const message of messages) {
				console.log(message)
			}
		})
	} else
		console.log("invalid config")
})
