/* global window */
// The stand-in add-on's screen: it fills Settings > Premium's slot, using Hearth's own React.
const { React, registerSlot, request } = window.hearthCore;
function Filled() {
  const [ok, setOk] = React.useState(false);
  React.useEffect(() => {
    request("GET", "/api/addons/test-addon/ping").then((r) => setOk(r.ok));
  }, []);
  return React.createElement(
    "p",
    { "data-testid": "test-addon-slot" },
    ok ? "Filled by the test add-on, and its route answered." : "Filled by the test add-on.",
  );
}
registerSlot("settings.premium", Filled);
