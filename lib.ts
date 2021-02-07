export type ValidReference = "boolean" | "number" | "string" | ValidReference[] | { [key: string]: ValidReference }

export type StringToType<T extends ValidReference> =
	T extends "boolean"
		? boolean :
	T extends "number"
		? number :
	T extends "string"
		? string :
	T extends ValidReference[]
		? StringToType<T[number]>[] | StringToType<T[number]> :
	T extends { [key: string]: ValidReference }
		? { [K in keyof T]: StringToType<T[K]> } :
	never

export function validate<T extends ValidReference>(target: any, validRef: T): target is StringToType<T> {
	const { isArray } = Array

	if (isArray(validRef)) {
		if (isArray(target)) {
			for (const value of target) {
				const isValid = validate(value, validRef)

				if (!isValid)
					return false
			}

			return true
		}

		for (const value of validRef) {
			const isValid = validate(target, value)

			if (isValid)
				return true
		}

		return false
	}

	if (target && typeof validRef == "object" && typeof target == "object") {
		for (const [ key, value ] of Object.entries(validRef)) {
			const isValid = validate(target[key], value)

			if (!isValid)
				return false
		}

		return true
	}

	return typeof target == validRef
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
