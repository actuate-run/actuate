# @actuate/runtime

The Actuate step engine: journaled steps, replay, sleeps on Durable Object alarms, events and signed approvals. Runs on workerd with SQLite, so you can self-host.

```ts
import { createRuntime } from "@actuate/runtime/worker";
import actuator from "./actuator";

const runtime = createRuntime(actuator);
export default runtime.worker;
export const ActuatorObject = runtime.ActuatorObject;
```

Docs: https://actuate.run/docs · Source: https://github.com/actuate-run/actuate

License: Apache-2.0
