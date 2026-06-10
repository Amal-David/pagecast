import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { motion, useReducedMotion } from "framer-motion";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  // Colors/shadow transition via CSS; the press/hover scale is driven by
  // framer-motion springs below for a livelier, physical feel.
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-[box-shadow,background-color,border-color,color] duration-150 ease-out focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 hover:shadow-md active:shadow-sm",
        destructive:
          "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90 hover:shadow-md active:shadow-sm",
        outline:
          "border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground hover:shadow",
        secondary:
          "bg-secondary text-secondary-foreground shadow-sm hover:bg-secondary/80 hover:shadow",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline"
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-8",
        icon: "h-9 w-9"
      }
    },
    defaultVariants: {
      variant: "default",
      size: "default"
    }
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const reduceMotion = useReducedMotion();
    const classes = cn(buttonVariants({ variant, size, className }));

    // asChild renders an arbitrary child (e.g. a dropdown trigger) — keep it a
    // plain Slot so we don't fight the child's own behavior/animations.
    if (asChild) {
      return <Slot className={classes} ref={ref} {...props} />;
    }

    // Strip the few DOM handlers whose names collide with framer-motion's
    // animation/drag events so the spread stays type-safe.
    const {
      onAnimationStart: _a,
      onAnimationEnd: _b,
      onDrag: _c,
      onDragStart: _d,
      onDragEnd: _e,
      ...rest
    } = props;

    return (
      <motion.button
        className={classes}
        ref={ref}
        whileTap={reduceMotion ? undefined : { scale: 0.94 }}
        whileHover={reduceMotion ? undefined : { scale: 1.02 }}
        transition={{ type: "spring", stiffness: 500, damping: 28, mass: 0.6 }}
        {...rest}
      />
    );
  }
);
Button.displayName = "Button";

export { Button, buttonVariants };
