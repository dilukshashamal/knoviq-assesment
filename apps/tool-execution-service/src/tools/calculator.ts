import { badRequest } from "../errors.js";
import { CalculatorArgumentsSchema, type CalculatorArguments } from "../schemas.js";
import type { ToolExecutionContext, ToolHandler } from "../types.js";

type Token =
  | { type: "number"; value: number }
  | { type: "operator"; value: "+" | "-" | "*" | "/" | "^" }
  | { type: "left_paren" }
  | { type: "right_paren" };

export class CalculatorTool implements ToolHandler<CalculatorArguments> {
  definition = {
    description:
      "Evaluates safe numeric arithmetic expressions with +, -, *, /, ^, and parentheses. No variables or code execution.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["expression"],
      properties: {
        expression: {
          type: "string",
          description: "Arithmetic expression, for example '(1250 + 850) / 2'.",
          maxLength: 500,
        },
        precision: {
          type: "integer",
          description: "Optional decimal places for rounding, 0 to 12.",
          minimum: 0,
          maximum: 12,
        },
      },
    },
    name: "calculator.evaluate" as const,
  };

  async execute(args: CalculatorArguments, _context: ToolExecutionContext) {
    const parsed = CalculatorArgumentsSchema.parse(args);
    const result = evaluateExpression(parsed.expression);
    const rounded =
      parsed.precision === undefined ? result : Number(result.toFixed(parsed.precision));

    return {
      expression: parsed.expression,
      result: rounded,
    };
  }
}

function evaluateExpression(expression: string): number {
  if (!/^[0-9eE+\-*/^().\s]+$/.test(expression)) {
    throw badRequest("Calculator expression contains unsupported characters");
  }

  const parser = new ExpressionParser(tokenize(expression));
  const value = parser.parse();

  if (!Number.isFinite(value)) {
    throw badRequest("Calculator result is not finite");
  }

  return value;
}

function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < expression.length) {
    const char = expression[index];

    if (!char) {
      break;
    }

    if (/\s/.test(char)) {
      index += 1;
      continue;
    }

    if (char === "(") {
      tokens.push({ type: "left_paren" });
      index += 1;
      continue;
    }

    if (char === ")") {
      tokens.push({ type: "right_paren" });
      index += 1;
      continue;
    }

    if (["+", "-", "*", "/", "^"].includes(char)) {
      tokens.push({ type: "operator", value: char as "+" | "-" | "*" | "/" | "^" });
      index += 1;
      continue;
    }

    const numberMatch = expression.slice(index).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?/i);

    if (!numberMatch?.[0]) {
      throw badRequest("Calculator expression contains an invalid number");
    }

    const value = Number(numberMatch[0]);

    if (!Number.isFinite(value)) {
      throw badRequest("Calculator expression contains a non-finite number");
    }

    tokens.push({ type: "number", value });
    index += numberMatch[0].length;
  }

  return tokens;
}

class ExpressionParser {
  private index = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): number {
    const value = this.parseExpression();

    if (this.peek()) {
      throw badRequest("Calculator expression has unexpected trailing input");
    }

    return value;
  }

  private parseExpression(): number {
    let value = this.parseTerm();

    while (true) {
      const token = this.peek();

      if (token?.type !== "operator" || (token.value !== "+" && token.value !== "-")) {
        return value;
      }

      this.consume();
      const right = this.parseTerm();
      value = token.value === "+" ? value + right : value - right;
    }
  }

  private parseTerm(): number {
    let value = this.parsePower();

    while (true) {
      const token = this.peek();

      if (token?.type !== "operator" || (token.value !== "*" && token.value !== "/")) {
        return value;
      }

      this.consume();
      const right = this.parsePower();

      if (token.value === "/" && right === 0) {
        throw badRequest("Calculator expression divides by zero");
      }

      value = token.value === "*" ? value * right : value / right;
    }
  }

  private parsePower(): number {
    let value = this.parseUnary();
    const token = this.peek();

    if (token?.type === "operator" && token.value === "^") {
      this.consume();
      const right = this.parsePower();
      value = value ** right;
    }

    return value;
  }

  private parseUnary(): number {
    const token = this.peek();

    if (token?.type === "operator" && (token.value === "+" || token.value === "-")) {
      this.consume();
      const value = this.parseUnary();
      return token.value === "-" ? -value : value;
    }

    return this.parsePrimary();
  }

  private parsePrimary(): number {
    const token = this.consume();

    if (!token) {
      throw badRequest("Calculator expression ended unexpectedly");
    }

    if (token.type === "number") {
      return token.value;
    }

    if (token.type === "left_paren") {
      const value = this.parseExpression();
      const closing = this.consume();

      if (closing?.type !== "right_paren") {
        throw badRequest("Calculator expression has unbalanced parentheses");
      }

      return value;
    }

    throw badRequest("Calculator expression expected a number or parenthesis");
  }

  private peek(): Token | undefined {
    return this.tokens[this.index];
  }

  private consume(): Token | undefined {
    const token = this.tokens[this.index];
    this.index += 1;
    return token;
  }
}
