# widget-tuning

## Since last update

- @aaaaaaa resolved+admitted v2-tuned: wibble 0.72 → 0.84.

## Abstract

Stub.

## 1. Question

<!-- locked: pre-registration -->
What configuration maximises wibble?

## 2. Background & related work

The wibble score is described in widget-papers/2025.

## 3. Method

<!-- locked: pre-registration -->
Sweep knob values; n=3 seeds; report mean and std.

## 4. Results

### v1-baseline

![baseline distribution](figures/v1-baseline.png)

Default knob=1.0 scored wibble=0.72 mean[^v1-baseline-c1].

[^v1-baseline-c1]: https://github.com/example/widget-tuning/commit/bbbbbbb · python sweep.py --knob 1.0 · outputs/v1/run.json

### v2-tuned

![tuned distribution](figures/v2-tuned.png)

Knob=1.5 scored wibble=0.84 mean[^v2-tuned-c1] — beats baseline by 0.12.

[^v2-tuned-c1]: https://github.com/example/widget-tuning/commit/aaaaaaa · python sweep.py --knob 1.5 · outputs/v2/run.json

## 5. Discussion

The wibble knob is load-bearing.

## 6. Limitations

- Only knob=1.0 and 1.5 tested.

## 7. Reproducibility appendix

`python sweep.py --knob <value> --seed <0..2>`

## 8. References

widget-papers/2025.
