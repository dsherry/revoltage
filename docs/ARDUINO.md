# Arduino wiring guide: 2× HC-SR04 distance sensors

This covers wiring only. The firmware will live in [`firmware/revoltage_sensors/`](../firmware/) once it's written (milestone M7 in [SPEC.md](SPEC.md)).

## What you need

- Arduino Uno R3 or a classic Nano (both are 5 V boards; the pin names below are the same on both)
- 2× HC-SR04 ultrasonic sensors
- A small breadboard, used for its power rails
- About 10 jumper wires, male-to-female for the sensor pins
- A USB cable to the laptop

## Pins

Each HC-SR04 has four pins, labeled on the board: **VCC, Trig, Echo, GND**.

| Sensor | Name in the platform | VCC | Trig | Echo | GND |
|---|---|---|---|---|---|
| A (left) | `distL` | 5V | **D2** | **D3** | GND |
| B (right) | `distR` | 5V | **D4** | **D5** | GND |

The Arduino has only one or two 5V/GND pins, so share them through the breadboard rails:

```
 Arduino 5V  ──────────► breadboard  + rail ──┬──► Sensor A VCC
                                              └──► Sensor B VCC
 Arduino GND ──────────► breadboard  − rail ──┬──► Sensor A GND
                                              └──► Sensor B GND
 Arduino D2  ──────────────────────────────────► Sensor A Trig
 Arduino D3  ──────────────────────────────────► Sensor A Echo
 Arduino D4  ──────────────────────────────────► Sensor B Trig
 Arduino D5  ──────────────────────────────────► Sensor B Echo
```

## Steps

1. **Unplug the USB cable** before wiring anything.
2. Run a wire from Arduino **5V** to the breadboard's **+** rail, and from Arduino **GND** to the **−** rail.
3. For each sensor, connect **VCC** to the + rail and **GND** to the − rail.
4. Connect the Trig and Echo pins to D2–D5 as in the table.
5. **Check VCC and GND before plugging in USB.** If they're swapped, the sensor can be destroyed. That's the only mistake here that can damage anything.
6. Plug in the USB cable. The Arduino's power LED should light. The sensors have no LED.

## Placement tips

- The range is about 2–400 cm. The sensors read best off flat, hard surfaces facing them; clothing and angled surfaces reflect less.
- **Point the two sensors in different directions or keep them well apart.** Otherwise one can hear the other's echo. The firmware also pings them alternately to reduce this.
- Each sensor gives roughly 15 readings per second. That's a limit of how the sensor works.
- Keep the wires short and secure (tape or hot glue) so nothing pulls loose on stage.

## Uploading code (later)

Once the firmware exists, it's uploaded from the terminal with the `arduino-cli` bundled inside the Arduino IDE, or you can open the sketch in the Arduino IDE and click Upload. Uploading over USB can't damage the board; if a sketch is wrong, upload a fixed one.

The sketch is always kept in the repo under `firmware/`.
