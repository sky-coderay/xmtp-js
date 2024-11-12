import type { MetaFunction } from "@remix-run/node";
import { App } from "~/src/App";

export const meta: MetaFunction = () => {
  return [{ title: "XMTP Remix Example" }];
};

export default function Index() {
  return <App />;
}
