'use strict';
// A minimal n8n runner for tests. It walks the workflow's connections from a trigger and runs the node types this
// workflow uses (Webhook, Schedule Trigger, Code, HTTP Request, IF, Wait) the way n8n does, with HTTP calls answered
// by a handler. It checks the wiring, every $('Node') reference and expression, and the Code nodes exactly as built.
// Not covered here, so checked by hand after importing: credentials, real API responses, n8n's own retries.

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

function makeDate(nowMs) {
  return class FakeDate extends Date {
    constructor(...args) {
      if (args.length) super(...args);
      else super(nowMs);
    }

    static now() {
      return nowMs;
    }
  };
}

class MiniN8n {
  // options: { http(request) -> response (throw to simulate a failed call), waitAnswer() -> body or null, staticData }
  constructor(workflow, options) {
    this.wf = workflow;
    this.byName = Object.fromEntries(workflow.nodes.map((n) => [n.name, n]));
    this.options = options;
    this.staticData = options.staticData || {};
  }

  async run(trigger, items, nowMs) {
    if (!this.byName[trigger]) throw new Error(`No trigger called ${trigger}`);
    this.nowMs = nowMs;
    this.outputs = {};
    this.order = [];
    await this.execute(trigger, items);
    return this;
  }

  ref(name) {
    const self = this;
    if (!this.byName[name]) throw new Error(`$('${name}') refers to a node that does not exist`);
    return {
      get isExecuted() {
        return name in self.outputs;
      },
      first() {
        if (!(name in self.outputs)) throw new Error(`Node '${name}' hasn't been executed`);
        const items = self.outputs[name].find((o) => o && o.length) || [];
        return items[0];
      },
      all() {
        if (!(name in self.outputs)) throw new Error(`Node '${name}' hasn't been executed`);
        return self.outputs[name].find((o) => o && o.length) || [];
      },
    };
  }

  env(items) {
    return {
      $: (name) => this.ref(name),
      $input: { first: () => items[0], last: () => items[items.length - 1], all: () => items },
      $json: items[0] ? items[0].json : {},
      $execution: { id: 'test', mode: 'production', resumeUrl: 'https://n8n.example.com/webhook-waiting/test?signature=abc' },
      Date: makeDate(this.nowMs),
    };
  }

  // n8n parameter values that start with "=" are expressions: "={{ js }}" or text with {{ js }} parts.
  evalParam(value, items) {
    if (typeof value !== 'string' || !value.startsWith('=')) return value;
    const e = this.env(items);
    const evaluate = (code) => new Function('$', '$input', '$json', '$execution', 'Date', `return (${code});`)(e.$, e.$input, e.$json, e.$execution, e.Date);
    const tpl = value.slice(1);
    const whole = /^\s*\{\{([\s\S]*)\}\}\s*$/.exec(tpl);
    if (whole && tpl.indexOf('{{') === tpl.lastIndexOf('{{')) return evaluate(whole[1]);
    return tpl.replace(/\{\{([\s\S]*?)\}\}/g, (_, c) => String(evaluate(c)));
  }

  async execute(name, items) {
    const node = this.byName[name];
    const outs = await this.runNode(node, items);
    this.outputs[name] = outs;
    this.order.push(name);
    const branches = (this.wf.connections[name] || {}).main || [];
    for (let i = 0; i < branches.length; i += 1) {
      const out = outs[i] || [];
      if (!out.length) continue;
      for (const target of branches[i]) await this.execute(target.node, out);
    }
  }

  async runNode(node, items) {
    switch (node.type) {
      case 'n8n-nodes-base.webhook':
      case 'n8n-nodes-base.scheduleTrigger':
        return [items];
      case 'n8n-nodes-base.code': {
        const fn = new AsyncFunction('$', '$input', '$json', '$execution', '$getWorkflowStaticData', 'Date', node.parameters.jsCode);
        const e = this.env(items);
        const getStatic = (scope) => {
          if (scope !== 'global') throw new Error('this workflow only uses global static data');
          return this.staticData;
        };
        const result = await fn(e.$, e.$input, e.$json, e.$execution, getStatic, e.Date);
        if (!Array.isArray(result) || result.some((it) => !it || typeof it.json !== 'object')) throw new Error(`${node.name} must return [{ json }] items`);
        return [result];
      }
      case 'n8n-nodes-base.if': {
        const yes = [];
        const no = [];
        for (const item of items) {
          const values = node.parameters.conditions.conditions.map((c) => {
            const v = this.evalParam(c.leftValue, [item]);
            if (typeof v !== 'boolean') throw new Error(`${node.name}: strict type validation needs a boolean, got ${typeof v}`);
            if (c.operator.type !== 'boolean' || c.operator.operation !== 'true') throw new Error(`${node.name}: unsupported operator`);
            return v === true;
          });
          (values.every(Boolean) ? yes : no).push(item);
        }
        return [yes, no];
      }
      case 'n8n-nodes-base.httpRequest': {
        const p = node.parameters;
        if (p.authentication && !node.credentials) throw new Error(`${node.name}: authentication set but no credentials`);
        const ok = [];
        const failed = [];
        for (const item of items) {
          const request = {
            node: node.name,
            method: p.method || 'GET',
            url: this.evalParam(p.url, [item]),
            headers: p.sendHeaders ? Object.fromEntries(p.headerParameters.parameters.map((h) => [h.name, this.evalParam(h.value, [item])])) : {},
            body: p.sendBody ? JSON.parse(this.evalParam(p.jsonBody, [item])) : undefined,
          };
          try {
            ok.push({ json: await this.options.http(request) });
          } catch (err) {
            if (node.onError === 'continueRegularOutput') ok.push({ json: { error: { message: err.message } } });
            else if (node.onError === 'continueErrorOutput') failed.push({ json: { error: { message: err.message } } });
            else throw err;
          }
        }
        return node.onError === 'continueErrorOutput' ? [ok, failed] : [ok];
      }
      case 'n8n-nodes-base.wait': {
        const body = this.options.waitAnswer();
        if (body) return [[{ json: { headers: {}, params: {}, query: {}, body } }]];
        return [items];
      }
      default:
        throw new Error(`MiniN8n cannot run ${node.type} (${node.name})`);
    }
  }
}

module.exports = { MiniN8n };
