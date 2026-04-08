/*
 * BKC32 - ESP32 + AD5933 Impedance Spectroscopy System
 * For Candida albicans detection via EIS
 *
 * Connections:
 *   ESP32 GPIO21 (SDA) -> AD5933 SDA
 *   ESP32 GPIO22 (SCL) -> AD5933 SCL
 *   AD5933 VDD         -> 3.3V
 *   AD5933 GND         -> GND
 *   AD5933 VOUT        -> Calibration resistor / Electrochemical cell input
 *   AD5933 VIN         -> Electrochemical cell output / Feedback path
 *
 * Serial protocol (115200 baud):
 *   Commands: PING, CFG, SWEEP/START, STOP, TEMP, CAL
 *   Responses: JSON-formatted data
 */

#include <Wire.h>
#include <math.h>

// ---- AD5933 I2C Address ----
#define AD5933_ADDR 0x0D

// ---- AD5933 Register Map ----
#define REG_CTRL_HB       0x80
#define REG_CTRL_LB       0x81
#define REG_FREQ_START_HB 0x82
#define REG_FREQ_START_MB 0x83
#define REG_FREQ_START_LB 0x84
#define REG_FREQ_INC_HB   0x85
#define REG_FREQ_INC_MB   0x86
#define REG_FREQ_INC_LB   0x87
#define REG_NUM_INC_HB    0x88
#define REG_NUM_INC_LB    0x89
#define REG_SETTLE_HB     0x8A
#define REG_SETTLE_LB     0x8B
#define REG_STATUS         0x8F
#define REG_TEMP_HB       0x92
#define REG_TEMP_LB       0x93
#define REG_REAL_HB       0x94
#define REG_REAL_LB       0x95
#define REG_IMAG_HB       0x96
#define REG_IMAG_LB       0x97

// ---- Control register commands ----
#define CTRL_INIT_FREQ    0x10
#define CTRL_START_SWEEP  0x20
#define CTRL_INC_FREQ     0x30
#define CTRL_REPEAT_FREQ  0x40
#define CTRL_MEASURE_TEMP 0x90
#define CTRL_POWER_DOWN   0xA0
#define CTRL_STANDBY      0xB0
#define CTRL_RESET        0x10

// ---- Status register bits ----
#define STATUS_TEMP_VALID  0x01
#define STATUS_DATA_VALID  0x02
#define STATUS_SWEEP_DONE  0x04

// ---- Output voltage range ----
#define RANGE_2VP   0x00
#define RANGE_200MV 0x06
#define RANGE_400MV 0x04
#define RANGE_1V    0x02

// ---- PGA gain ----
#define PGA_GAIN_1X 0x01
#define PGA_GAIN_5X 0x00

// ---- Internal clock ----
#define MCLK 16776000.0  // 16.776 MHz internal oscillator

// ---- Sweep configuration ----
struct SweepConfig {
  float startFreq;     // Hz
  float endFreq;       // Hz
  uint16_t numPoints;  // number of frequency points
  uint8_t voltRange;   // output voltage range
  uint8_t pgaGain;     // PGA gain setting
  uint16_t settleTime; // settling cycles
};

SweepConfig config = {
  .startFreq   = 1000.0,
  .endFreq     = 100000.0,
  .numPoints   = 50,
  .voltRange   = RANGE_1V,
  .pgaGain     = PGA_GAIN_1X,
  .settleTime  = 15
};

// ---- Calibration ----
float gainFactor = 1.0;
float systemPhase = 0.0;
bool calibrated = false;
float calResistance = 10000.0;

// ---- State ----
bool sweepRunning = false;
String inputBuffer = "";

// ---- AD5933 I2C helpers ----

bool writeReg(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(AD5933_ADDR);
  Wire.write(reg);
  Wire.write(val);
  return Wire.endTransmission() == 0;
}

uint8_t readReg(uint8_t reg) {
  Wire.beginTransmission(AD5933_ADDR);
  Wire.write(reg);
  Wire.endTransmission(false);
  Wire.requestFrom((uint8_t)AD5933_ADDR, (uint8_t)1);
  return Wire.available() ? Wire.read() : 0;
}

bool setControlMode(uint8_t mode) {
  uint8_t current = readReg(REG_CTRL_HB);
  current = (current & 0x0F) | (mode & 0xF0);
  return writeReg(REG_CTRL_HB, current);
}

// ---- Frequency encoding ----

uint32_t freqToCode(float freq) {
  return (uint32_t)((freq / (MCLK / 4.0)) * pow(2, 27));
}

void setStartFrequency(float freq) {
  uint32_t code = freqToCode(freq);
  writeReg(REG_FREQ_START_HB, (code >> 16) & 0xFF);
  writeReg(REG_FREQ_START_MB, (code >> 8) & 0xFF);
  writeReg(REG_FREQ_START_LB, code & 0xFF);
}

void setFrequencyIncrement(float startFreq, float endFreq, uint16_t numPoints) {
  float inc = (numPoints > 1) ? (endFreq - startFreq) / (numPoints - 1) : 0;
  uint32_t code = freqToCode(inc);
  writeReg(REG_FREQ_INC_HB, (code >> 16) & 0xFF);
  writeReg(REG_FREQ_INC_MB, (code >> 8) & 0xFF);
  writeReg(REG_FREQ_INC_LB, code & 0xFF);
}

void setNumIncrements(uint16_t num) {
  if (num > 511) num = 511;
  writeReg(REG_NUM_INC_HB, (num >> 8) & 0x01);
  writeReg(REG_NUM_INC_LB, num & 0xFF);
}

void setSettlingCycles(uint16_t cycles) {
  writeReg(REG_SETTLE_HB, (cycles >> 8) & 0x01);
  writeReg(REG_SETTLE_LB, cycles & 0xFF);
}

void setVoltageRange(uint8_t range) {
  uint8_t current = readReg(REG_CTRL_HB);
  current = (current & 0xF9) | (range & 0x06);
  writeReg(REG_CTRL_HB, current);
}

void setPGAGain(uint8_t gain) {
  uint8_t current = readReg(REG_CTRL_LB);
  current = (current & 0xFE) | (gain & 0x01);
  writeReg(REG_CTRL_LB, current);
}

// ---- Configure sweep parameters ----

void configureSweep() {
  setControlMode(CTRL_STANDBY << 4);
  delay(10);
  setStartFrequency(config.startFreq);
  setFrequencyIncrement(config.startFreq, config.endFreq, config.numPoints);
  setNumIncrements(config.numPoints - 1);
  setSettlingCycles(config.settleTime);
  setVoltageRange(config.voltRange);
  setPGAGain(config.pgaGain);
}

// ---- Read impedance data ----

bool readImpedanceData(int16_t *real, int16_t *imag) {
  uint8_t rHB = readReg(REG_REAL_HB);
  uint8_t rLB = readReg(REG_REAL_LB);
  uint8_t iHB = readReg(REG_IMAG_HB);
  uint8_t iLB = readReg(REG_IMAG_LB);
  *real = (int16_t)((rHB << 8) | rLB);
  *imag = (int16_t)((iHB << 8) | iLB);
  return true;
}

// ---- Temperature measurement ----

float readTemperature() {
  setControlMode(CTRL_MEASURE_TEMP << 4);
  delay(10);
  unsigned long timeout = millis() + 1000;
  while (!(readReg(REG_STATUS) & STATUS_TEMP_VALID)) {
    if (millis() > timeout) return -999.0;
    delay(1);
  }
  uint8_t tHB = readReg(REG_TEMP_HB);
  uint8_t tLB = readReg(REG_TEMP_LB);
  int16_t rawTemp = ((tHB & 0x1F) << 8) | tLB;
  if (rawTemp & 0x1000) {
    rawTemp = rawTemp - 8192;
  }
  return rawTemp / 32.0;
}

// ---- Calibration ----

void performCalibration(float knownResistance) {
  calResistance = knownResistance;
  configureSweep();
  delay(10);
  setControlMode(CTRL_STANDBY << 4);
  delay(10);
  setControlMode(CTRL_INIT_FREQ << 4);
  delay(100);
  setControlMode(CTRL_START_SWEEP << 4);

  unsigned long timeout = millis() + 5000;
  while (!(readReg(REG_STATUS) & STATUS_DATA_VALID)) {
    if (millis() > timeout) {
      Serial.println("{\"error\":\"calibration timeout\"}");
      return;
    }
    delay(5);
  }

  int16_t real, imag;
  readImpedanceData(&real, &imag);
  float magnitude = sqrt((float)real * real + (float)imag * imag);
  gainFactor = 1.0 / (magnitude * knownResistance);
  systemPhase = atan2((float)imag, (float)real);
  calibrated = true;
  setControlMode(CTRL_POWER_DOWN << 4);

  Serial.print("{\"type\":\"cal\",\"gain\":");
  Serial.print(gainFactor, 10);
  Serial.print(",\"phase\":");
  Serial.print(systemPhase, 6);
  Serial.print(",\"R_cal\":");
  Serial.print(knownResistance, 1);
  Serial.println("}");
}

// ---- Frequency sweep ----

void executeSweep() {
  if (!calibrated) {
    Serial.println("{\"error\":\"not calibrated, run CAL first\"}");
    return;
  }

  sweepRunning = true;
  configureSweep();
  delay(10);
  setControlMode(CTRL_STANDBY << 4);
  delay(10);
  setControlMode(CTRL_INIT_FREQ << 4);
  delay(100);
  setControlMode(CTRL_START_SWEEP << 4);

  float freqStep = (config.numPoints > 1)
    ? (config.endFreq - config.startFreq) / (config.numPoints - 1)
    : 0;

  Serial.println("{\"type\":\"sweep_start\",\"points\":" + String(config.numPoints) + "}");

  for (uint16_t i = 0; i < config.numPoints && sweepRunning; i++) {
    unsigned long timeout = millis() + 3000;
    while (!(readReg(REG_STATUS) & STATUS_DATA_VALID)) {
      if (millis() > timeout) {
        Serial.println("{\"error\":\"data timeout at point " + String(i) + "\"}");
        sweepRunning = false;
        setControlMode(CTRL_POWER_DOWN << 4);
        return;
      }
      delay(1);
      if (Serial.available()) {
        String peek = Serial.readStringUntil('\n');
        peek.trim();
        if (peek == "STOP") {
          sweepRunning = false;
          setControlMode(CTRL_POWER_DOWN << 4);
          Serial.println("{\"type\":\"sweep_stopped\"}");
          return;
        }
      }
    }

    int16_t real, imag;
    readImpedanceData(&real, &imag);

    float magnitude = sqrt((float)real * real + (float)imag * imag);
    float impedance = 1.0 / (gainFactor * magnitude);
    float phase = atan2((float)imag, (float)real) - systemPhase;
    float reZ = impedance * cos(phase);
    float imZ = impedance * sin(phase);
    float freq = config.startFreq + i * freqStep;

    Serial.print("{\"type\":\"data\",\"i\":");
    Serial.print(i);
    Serial.print(",\"f\":");
    Serial.print(freq, 2);
    Serial.print(",\"Z\":");
    Serial.print(impedance, 4);
    Serial.print(",\"phase\":");
    Serial.print(phase * 180.0 / PI, 4);
    Serial.print(",\"reZ\":");
    Serial.print(reZ, 4);
    Serial.print(",\"imZ\":");
    Serial.print(imZ, 4);
    Serial.println("}");

    if (readReg(REG_STATUS) & STATUS_SWEEP_DONE) break;
    setControlMode(CTRL_INC_FREQ << 4);
  }

  setControlMode(CTRL_POWER_DOWN << 4);
  sweepRunning = false;
  Serial.println("{\"type\":\"sweep_done\"}");
}

// ---- Serial command processing ----

void processCommand(String cmd) {
  cmd.trim();

  String upper = cmd;
  upper.toUpperCase();

  if (upper == "PING") {
    Serial.println("{\"type\":\"pong\",\"device\":\"BKC32-EIS\",\"version\":\"1.0\"}");
  }
  else if (upper == "TEMP") {
    float temp = readTemperature();
    Serial.print("{\"type\":\"temp\",\"value\":");
    Serial.print(temp, 2);
    Serial.println("}");
  }
  else if (upper.startsWith("CFG")) {
    int idx = cmd.indexOf(':');
    if (idx < 0) {
      Serial.print("{\"type\":\"cfg\",\"fmin\":");
      Serial.print(config.startFreq, 1);
      Serial.print(",\"fmax\":");
      Serial.print(config.endFreq, 1);
      Serial.print(",\"npoints\":");
      Serial.print(config.numPoints);
      Serial.print(",\"settle\":");
      Serial.print(config.settleTime);
      Serial.print(",\"calibrated\":");
      Serial.print(calibrated ? "true" : "false");
      Serial.println("}");
      return;
    }
    String params = cmd.substring(idx + 1);
    float vals[4];
    int vIdx = 0;
    int start = 0;
    for (int j = 0; j <= (int)params.length() && vIdx < 4; j++) {
      if (j == (int)params.length() || params.charAt(j) == ',') {
        vals[vIdx++] = params.substring(start, j).toFloat();
        start = j + 1;
      }
    }
    if (vIdx >= 2) {
      config.startFreq = vals[0];
      config.endFreq = vals[1];
    }
    if (vIdx >= 3) config.numPoints = (uint16_t)vals[2];
    if (vIdx >= 4) config.settleTime = (uint16_t)vals[3];
    if (config.numPoints < 2) config.numPoints = 2;
    if (config.numPoints > 511) config.numPoints = 511;
    Serial.print("{\"type\":\"cfg_ok\",\"fmin\":");
    Serial.print(config.startFreq, 1);
    Serial.print(",\"fmax\":");
    Serial.print(config.endFreq, 1);
    Serial.print(",\"npoints\":");
    Serial.print(config.numPoints);
    Serial.print(",\"settle\":");
    Serial.print(config.settleTime);
    Serial.println("}");
  }
  else if (upper.startsWith("CAL")) {
    float r = calResistance;
    int idx = cmd.indexOf(':');
    if (idx >= 0) {
      r = cmd.substring(idx + 1).toFloat();
      if (r <= 0) r = calResistance;
    }
    performCalibration(r);
  }
  else if (upper == "START" || upper == "SWEEP") {
    executeSweep();
  }
  else if (upper == "STOP") {
    sweepRunning = false;
    setControlMode(CTRL_POWER_DOWN << 4);
    Serial.println("{\"type\":\"stopped\"}");
  }
  else {
    Serial.println("{\"error\":\"unknown command\"}");
  }
}

void handleSerial() {
  while (Serial.available()) {
    char c = Serial.read();
    if (c == '\n' || c == '\r') {
      if (inputBuffer.length() > 0) {
        processCommand(inputBuffer);
        inputBuffer = "";
      }
    } else {
      inputBuffer += c;
    }
  }
}

// ---- Setup & Loop ----

void setup() {
  Serial.begin(115200);
  Wire.begin(21, 22);
  Wire.setClock(400000);
  delay(500);

  setControlMode(CTRL_RESET << 4);
  delay(100);
  setControlMode(CTRL_STANDBY << 4);

  Serial.println("{\"type\":\"ready\",\"device\":\"BKC32-EIS\",\"version\":\"1.0\"}");
}

void loop() {
  handleSerial();
  delay(1);
}
