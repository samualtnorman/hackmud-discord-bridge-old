export type ValidReference = "boolean" | "number" | "string" | { [key: string]: ValidReference } | [ "array" | "union" | "record", ValidReference[] ]

type StringToType<T extends ValidReference> =
	T extends "boolean"
		? boolean :
	T extends "number"
		? number :
	T extends "string"
		? string :
	T extends [ "array", ValidReference[] ]
		? StringToType<T[1][number]>[] :
	T extends [ "union", ValidReference[] ]
		? StringToType<T[1][number]> :
	T extends [ "record", ValidReference[] ]
		? Record<string, StringToType<T[1][number]>> :
	T extends { [key: string]: ValidReference }
		? { [K in keyof T]: StringToType<T[K]> } :
	never

export function validate<T extends ValidReference>(target: unknown, validReference: T): target is StringToType<T> {
	if (validReference instanceof Array) {
		const [ type, validReferenceUnion ] = validReference as [ "array" | "union" | "record", ValidReference[] ]

		switch (type) {
			case "array":
				if (!(target instanceof Array))
					return false

				for (const value of target) {
					if (!validate(value, [ "union", validReferenceUnion ]))
						return false
				}

				return true

			case "union":
				for (const validReferenceUnionValue of validReferenceUnion) {
					if (validate(target, validReferenceUnionValue))
						return true
				}

				return false

			case "record":
				if (typeof target != "object" || !target)
					return false

				return validate(Object.values(target), [ "array", validReferenceUnion ])
		}
	}

	if (target && typeof validReference == "object" && typeof target == "object") {
		for (const [ key, value ] of Object.entries(validReference)) {
			if (!validate((target as Record<string, unknown>)[key], value))
				return false
		}

		return true
	}

	return typeof target == validReference
}

export class DynamicMap<K, V> extends Map<K, V> {
	constructor(private fallbackHandler: (key: K) => V) { super() }

	get(key: K) {
		let value = super.get(key)

		if (value)
			return value

		value = this.fallbackHandler(key)

		this.set(key, value)

		return value
	}
}

export async function asyncReplace(str: string, regex: RegExp, asyncFn: (substring: string, ...args: any) => Promise<string>) {
	const promises: Promise<string>[] = []

	str.replace(regex, (match, ...args) => {
		promises.push(asyncFn(match, ...args))
		return ""
	})

	const data = await Promise.all(promises)

	return str.replace(regex, () => data.shift()!)
}

export function* matches(regex: RegExp, string: string) {
	let current

	while (current = regex.exec(string)) {
		yield {
			index: current.index,
			match: current[1] ?? current[0],
			matches: [ ...current ]
		}
	}
}
