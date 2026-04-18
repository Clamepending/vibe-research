import assert from "node:assert/strict";
import test from "node:test";
import { collectSystemMetrics, testInternals } from "../src/system-metrics.js";

const DF_ALL = `Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/root 1000 800 100 90% /
`;

const NVIDIA_CSV = "0, NVIDIA RTX 6000, 42, 17, 2048, 49152, 61, 118.2, 300\n";

function createCpuSequence() {
  const snapshots = [
    [
      {
        model: "Test CPU",
        speed: 3200,
        times: { user: 100, nice: 0, sys: 100, idle: 800, irq: 0 },
      },
      {
        model: "Test CPU",
        speed: 3200,
        times: { user: 200, nice: 0, sys: 100, idle: 700, irq: 0 },
      },
    ],
    [
      {
        model: "Test CPU",
        speed: 3200,
        times: { user: 150, nice: 0, sys: 100, idle: 850, irq: 0 },
      },
      {
        model: "Test CPU",
        speed: 3200,
        times: { user: 250, nice: 0, sys: 150, idle: 700, irq: 0 },
      },
    ],
  ];
  let index = 0;

  return () => snapshots[Math.min(index++, snapshots.length - 1)];
}

test("collectSystemMetrics reports storage, wiki usage, per-core CPU, memory, and NVIDIA GPU utilization", async () => {
  const commands = [];
  const system = await collectSystemMetrics({
    cwd: "/workspace/project",
    platform: "linux",
    sampleMs: 1,
    projectPaths: ["/workspace/project", "/workspace/project/subdir"],
    projectStorageCache: new Map(),
    wikiPath: "/workspace/wiki",
    wikiStorageCache: new Map(),
    cpus: createCpuSequence(),
    totalmem: () => 16_000,
    freemem: () => 4_000,
    async execFile(command, args) {
      commands.push([command, ...args].join(" "));

      if (command === "df" && args.at(-1) === "/workspace/project") {
        return { stdout: DF_ALL, stderr: "" };
      }

      if (command === "df") {
        return { stdout: DF_ALL, stderr: "" };
      }

      if (command === "du" && args.join(" ") === "-sk /workspace/wiki") {
        return { stdout: "12\t/workspace/wiki\n", stderr: "" };
      }

      if (command === "du" && args.join(" ") === "-sk /workspace/project") {
        return { stdout: "80\t/workspace/project\n", stderr: "" };
      }

      if (command === "nvidia-smi") {
        return { stdout: NVIDIA_CSV, stderr: "" };
      }

      throw new Error(`unexpected command: ${command}`);
    },
    async readdir() {
      return [];
    },
    async readFile() {
      throw new Error("not found");
    },
  });

  assert.ok(commands.some((command) => command.startsWith("df -kP -l")));
  assert.equal(system.storage.primary.name, "Root");
  assert.equal(system.storage.primary.usedBytes, 900 * 1024);
  assert.equal(system.storage.primary.availableBytes, 100 * 1024);
  assert.equal(system.wikiStorage.path, "/workspace/wiki");
  assert.equal(system.wikiStorage.exists, true);
  assert.equal(system.wikiStorage.bytes, 12 * 1024);
  assert.equal(system.wikiStorage.source, "du");
  assert.equal(system.projectStorage.exists, true);
  assert.equal(system.projectStorage.bytes, 80 * 1024);
  assert.equal(system.projectStorage.rootCount, 1);
  assert.equal(system.projectStorage.totalRootCount, 1);
  assert.equal(system.cpu.coreCount, 2);
  assert.equal(Math.round(system.cpu.cores[0].utilizationPercent), 50);
  assert.equal(Math.round(system.cpu.cores[1].utilizationPercent), 100);
  assert.equal(system.memory.usedPercent, 75);
  assert.equal(system.gpus.length, 1);
  assert.equal(system.gpus[0].name, "NVIDIA RTX 6000");
  assert.equal(system.gpus[0].utilizationPercent, 42);
  assert.equal(system.gpus[0].memoryTotalBytes, 49152 * 1024 * 1024);
});

test("project storage roots are deduped before measurement", () => {
  assert.deepEqual(testInternals.dedupeNestedStorageRoots(["/workspace/project/a", "/workspace/project", "/tmp/x"]), [
    "/tmp/x",
    "/workspace/project",
  ]);
  assert.deepEqual(testInternals.dedupeNestedStorageRoots(["/", "/tmp/x"]), ["/"]);
});

test("macOS ioreg parsers detect Apple GPU utilization and Neural Engine inventory", () => {
  const gpuOutput = `+-o AGXAcceleratorG15X  <class AGXAcceleratorG15X>
    {
      "PerformanceStatistics" = {"Renderer Utilization %"=58,"Device Utilization %"=95,"Tiler Utilization %"=61,"In use system memory"=1234,"Alloc system memory"=9000}
      "model" = "Apple M3 Pro"
      "gpu-core-count" = 18
    }
`;
  const aneOutput = `+-o H11ANE  <class H11ANEIn>
    {
      "DeviceProperties" = {"ANEDevicePropertyNumANECores"=16,"ANEDevicePropertyTypeANEArchitectureTypeStr"="h15g"}
    }
`;

  const gpus = testInternals.parseMacGpuIoreg(gpuOutput);
  const accelerators = testInternals.parseMacAneIoreg(aneOutput);

  assert.equal(gpus.length, 1);
  assert.equal(gpus[0].name, "Apple M3 Pro");
  assert.equal(gpus[0].utilizationPercent, 95);
  assert.equal(gpus[0].rendererUtilizationPercent, 58);
  assert.equal(gpus[0].cores, 18);
  assert.equal(accelerators.length, 1);
  assert.equal(accelerators[0].name, "Apple Neural Engine");
  assert.equal(accelerators[0].cores, 16);
  assert.equal(accelerators[0].architecture, "h15g");
});
